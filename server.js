require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const db = require('./db');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const PORT = Number(process.env.PORT || 4242);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 20);
const HOLD_HOURS = Number(process.env.HOLD_HOURS || 24);

// Seller's share of an order. The platform keeps the rest (and pays Stripe's fee out of it).
function sellerShare(order) {
  const fee = Math.round((order.amount * FEE_PERCENT) / 100);
  return { fee, payout: order.amount - fee };
}

// ---------------------------------------------------------------------------
// Webhook. Registered BEFORE express.json() because signature verification
// needs the raw body.
// ---------------------------------------------------------------------------
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature failed: ${err.message}`);
  }

  // Card payments complete synchronously. If you accept bank debits etc.,
  // also handle checkout.session.async_payment_succeeded the same way.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata.orderId;
    const order = db.getOrder(orderId);

    if (order && order.status === 'PENDING_PAYMENT') {
      // We need the charge id later for source_transaction.
      const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
      db.upsertOrder({
        ...order,
        status: 'HELD',
        paymentIntentId: pi.id,
        chargeId: pi.latest_charge,
        paidAt: Date.now(),
      });
      console.log(`[webhook] ${orderId} paid, funds HELD on platform`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// ---------------------------------------------------------------------------
// 1. Create a seller (Express account that can receive transfers).
// For the minimal "country only" version of this, see the deferred onboarding repo.
// ---------------------------------------------------------------------------
app.post('/sellers', async (req, res) => {
  const { email, country = 'US' } = req.body;

  const account = await stripe.accounts.create({
    type: 'express',
    country,
    email,
    capabilities: { transfers: { requested: true } },
    // Option 1 from the README would go here:
    // settings: { payouts: { schedule: { delay_days: 7 } } },
  });

  db.upsertSeller({ id: account.id, email, country });

  const link = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: `${BASE_URL}/sellers/${account.id}/onboard`,
    return_url: `${BASE_URL}/sellers/${account.id}/done`,
    type: 'account_onboarding',
  });

  res.json({ sellerId: account.id, onboardingUrl: link.url });
});

// ---------------------------------------------------------------------------
// 2. Checkout. The buyer pays the PLATFORM. No transfer_data, so nothing
// moves to the seller yet.
// ---------------------------------------------------------------------------
app.post('/checkout', async (req, res) => {
  const { sellerId, amount, currency = 'usd', description = 'Session' } = req.body;
  if (!db.getSeller(sellerId)) return res.status(404).json({ error: 'Unknown seller' });

  const orderId = `order_${Date.now()}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: { currency, unit_amount: amount, product_data: { name: description } },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      // Links this charge to the transfer we create later. Not required, but
      // it makes the dashboard show "what was paid out against this payment".
      transfer_group: orderId,
      metadata: { orderId, sellerId },
      // NOTE: no transfer_data, no application_fee_amount. That's the point.
    },
    metadata: { orderId, sellerId },
    success_url: `${BASE_URL}/success?order=${orderId}`,
    cancel_url: `${BASE_URL}/cancel?order=${orderId}`,
  });

  db.upsertOrder({
    id: orderId,
    sellerId,
    amount,
    currency,
    status: 'PENDING_PAYMENT',
    checkoutSessionId: session.id,
    createdAt: Date.now(),
  });

  res.json({ orderId, url: session.url });
});

// ---------------------------------------------------------------------------
// 3. The release condition. In a real app this is "buyer confirmed", "session
// end time passed", "delivery scanned", etc. Here it's an endpoint.
// ---------------------------------------------------------------------------
app.post('/orders/:id/complete', (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Unknown order' });
  if (order.status !== 'HELD') {
    return res.status(400).json({ error: `Order is ${order.status}, expected HELD` });
  }

  const updated = db.upsertOrder({
    ...order,
    status: 'COMPLETED',
    completedAt: Date.now(),
    releaseAt: Date.now() + HOLD_HOURS * 60 * 60 * 1000,
  });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// 4. Release: transfer the seller's share for every order whose hold has
// expired. Runs on a timer; also exposed as POST /release for testing.
// ---------------------------------------------------------------------------
async function releaseDueOrders() {
  const due = db
    .listOrders()
    .filter((o) => o.status === 'COMPLETED' && o.releaseAt <= Date.now());

  const results = [];
  for (const order of due) {
    const { fee, payout } = sellerShare(order);
    try {
      const transfer = await stripe.transfers.create(
        {
          amount: payout,
          currency: order.currency,
          destination: order.sellerId,
          transfer_group: order.id,
          // Ties the transfer to the original charge. Lets you transfer while the
          // charge's funds are still pending (not yet "available"), and keeps the
          // accounting linked. Must be the same currency as the charge, and the
          // amount can't exceed what's left on the charge after refunds.
          source_transaction: order.chargeId,
          metadata: { orderId: order.id },
        },
        // Cron jobs run twice. Webhooks retry. This makes a double run harmless.
        { idempotencyKey: `release-${order.id}` }
      );

      db.upsertOrder({
        ...order,
        status: 'RELEASED',
        transferId: transfer.id,
        platformFee: fee,
        releasedAt: Date.now(),
      });
      console.log(`[release] ${order.id} -> ${transfer.id} (${payout} ${order.currency} to ${order.sellerId})`);
      results.push({ orderId: order.id, transferId: transfer.id });
    } catch (err) {
      // Most common cause in production: your platform balance was swept to your
      // bank by automatic payouts. See platform-payout.js and the README.
      console.error(`[release] ${order.id} failed: ${err.message}`);
      results.push({ orderId: order.id, error: err.message });
    }
  }
  return results;
}

app.post('/release', async (req, res) => res.json(await releaseDueOrders()));
setInterval(releaseDueOrders, 60 * 1000);

// ---------------------------------------------------------------------------
// Refund. Two different paths depending on whether the seller has been paid.
// ---------------------------------------------------------------------------
app.post('/orders/:id/refund', async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Unknown order' });

  try {
    if (order.status === 'HELD' || order.status === 'COMPLETED') {
      // Seller was never paid. Plain refund, nothing to reverse.
      const refund = await stripe.refunds.create(
        { payment_intent: order.paymentIntentId },
        { idempotencyKey: `refund-${order.id}` }
      );
      db.upsertOrder({ ...order, status: 'REFUNDED', refundId: refund.id, refundedAt: Date.now() });
    } else if (order.status === 'RELEASED') {
      // Seller was paid. Pull the transfer back first, then refund the buyer.
      // If the seller already paid out to their bank, Stripe recovers the
      // reversal from their future transfers (or it fails in some countries).
      const reversal = await stripe.transfers.createReversal(
        order.transferId,
        {},
        { idempotencyKey: `reverse-${order.id}` }
      );
      const refund = await stripe.refunds.create(
        { payment_intent: order.paymentIntentId },
        { idempotencyKey: `refund-${order.id}` }
      );
      db.upsertOrder({
        ...order,
        status: 'REFUNDED',
        reversalId: reversal.id,
        refundId: refund.id,
        refundedAt: Date.now(),
      });
    } else {
      return res.status(400).json({ error: `Cannot refund an order in state ${order.status}` });
    }
    res.json(db.getOrder(order.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/orders', (req, res) => res.json(db.listOrders()));
app.get('/success', (req, res) => res.send(`Paid. Order ${req.query.order} is now held on the platform.`));
app.get('/cancel', (req, res) => res.send('Checkout cancelled.'));
app.get('/sellers/:id/done', (req, res) => res.send('Onboarding complete. You can close this tab.'));
app.get('/sellers/:id/onboard', (req, res) => res.send('Onboarding link expired. Create a new one via POST /sellers.'));

app.listen(PORT, () => console.log(`Escrow example on ${BASE_URL} (hold ${HOLD_HOURS}h, fee ${FEE_PERCENT}%)`));
