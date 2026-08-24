# Stripe Connect Escrow Example (separate charges and transfers)

Hold a buyer's payment on your platform, pay the seller only after the job is done, keep your commission, refund cleanly on both sides of the release.

Built for the video **"Stripe Connect Escrow: Hold Funds Until the Job Is Done (2026)"** on [The Marketplace Guy](https://www.youtube.com/@themarketplaceguy). Companion to the [deferred onboarding example](https://github.com/razz1000/stripe-connect-deferred-onboarding-example-repo), which covers *how sellers get a Stripe account*. This repo covers *when their money moves*.

The scenario from the comments: a customer pays for a 60-minute session, the platform takes 20%, the provider is paid 24 hours after the session. Every number is an environment variable.

> Want this without the cron job? [Prometora](https://www.prometora.com) has held payouts, release on confirmation, and the refund paths built in. 14-day trial.

---

## How the money flows

```
                 1. Checkout (no transfer_data)
  Buyer  ─────────────────────────────────────▶  PLATFORM balance   $100
                                                       │
                                                       │  order = HELD
                                                       │
                 2. POST /orders/:id/complete          │  order = COMPLETED
                    releaseAt = now + HOLD_HOURS       │
                                                       │
                 3. cron: releaseDueOrders()           │
                    transfers.create({                 │
                      amount: 80,                      ▼
                      source_transaction: charge })  ─────▶  SELLER balance   $80
                                                                 (platform keeps $20)
                                                       order = RELEASED

  Refund while HELD/COMPLETED:  refunds.create(payment_intent)          → seller never involved
  Refund after RELEASED:        transfers.createReversal + refunds.create → pulls $80 back first
```

Order states: `PENDING_PAYMENT → HELD → COMPLETED → RELEASED`, or `→ REFUNDED` from HELD, COMPLETED or RELEASED.

---

## Three ways to delay a payout (pick one)

| Option | Where the seller's share sits | Who controls release | Code | Use when |
|---|---|---|---|---|
| 1. `delay_days` on the seller's payout schedule | Seller's Stripe balance | Nobody, it's a timer | 1 line at account creation | You just want a buffer before the bank |
| 2. Destination charge + `manual` payouts on the seller | Seller's Stripe balance | You, via `payouts.create` on their behalf | ~10 lines | Booking marketplaces that want control without holding funds themselves |
| 3. Separate charges and transfers (**this repo**) | Your platform balance | You, via `transfers.create` | This repo | Real escrow: condition-based release, refunds without touching the seller |

Options 1 and 2 are shown at the bottom of this README. Option 3 is the main code.

---

## Prerequisites

- Node 18+
- A Stripe account with **Connect enabled** (Dashboard → Connect → Get started, pick "platform or marketplace")
- [Stripe CLI](https://docs.stripe.com/stripe-cli) for local webhooks
- Test mode. Everything here runs on `sk_test_` keys.

Separate charges and transfers require the platform and the connected account to be in the **same region** (both US, both EU, etc.). Check [Stripe's current docs](https://docs.stripe.com/connect/separate-charges-and-transfers) for your countries before building on this.

---

## Setup

```bash
git clone https://github.com/razz1000/stripe-connect-escrow-example-repo
cd stripe-connect-escrow-example-repo
npm install
cp .env.example .env
# fill in STRIPE_SECRET_KEY
```

Terminal 1, forward webhooks and copy the `whsec_...` it prints into `.env`:

```bash
stripe listen --forward-to localhost:4242/webhook
```

Terminal 2:

```bash
npm start
```

Set `HOLD_HOURS=0` in `.env` while testing so you don't wait a day.

---

## Walkthrough

**1. Create a seller** (Express account, `transfers` capability). Open the returned `onboardingUrl` and complete Stripe's test onboarding once, so the account can receive transfers.

```bash
curl -X POST localhost:4242/sellers -H 'content-type: application/json' \
  -d '{"email":"provider@example.com","country":"US"}'
```

**2. Create a checkout** for that seller. Open the returned `url` and pay with `4242 4242 4242 4242`.

```bash
curl -X POST localhost:4242/checkout -H 'content-type: application/json' \
  -d '{"sellerId":"acct_...","amount":10000,"currency":"usd","description":"60-minute session"}'
```

**3. Check the order.** The webhook has stored the charge ID and set the status to `HELD`.

```bash
curl localhost:4242/orders
```

**4. Mark it complete** (the session happened). Sets `releaseAt`.

```bash
curl -X POST localhost:4242/orders/order_.../complete
```

**5. Release.** The cron runs every minute; call it directly to skip the wait.

```bash
curl -X POST localhost:4242/release
```

In the Stripe dashboard: Connect → Accounts → your seller → Balance shows $80 incoming. Open the original $100 payment and the transfer is listed under it (linked by `transfer_group`).

**6. Refund** (works in any state, takes the right path automatically).

```bash
curl -X POST localhost:4242/orders/order_.../refund
```

---

## Files

```
.
├── server.js              # the 4 endpoints + webhook + release cron
├── db.js                  # JSON-file "database" (data.json)
├── platform-payout.js     # pays YOUR bank only what isn't held in escrow
├── .env.example
└── package.json
```

### package.json

```json
{
  "name": "stripe-connect-escrow-example",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js",
    "payout": "node platform-payout.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "stripe": "^17.0.0"
  }
}
```

### .env.example

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
BASE_URL=http://localhost:4242
PORT=4242

# Your commission, in percent of the order total. Note: the platform pays the
# Stripe processing fee on separate charges, so this needs to cover it.
PLATFORM_FEE_PERCENT=20

# Hours between "complete" and the transfer. 0 for testing, 24 for the video scenario.
HOLD_HOURS=24
```

### db.js

```js
// Minimal JSON-file persistence. Replace with a real database in production.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(FILE)) return { sellers: {}, orders: {} };
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  upsertSeller(seller) {
    const data = load();
    data.sellers[seller.id] = { ...(data.sellers[seller.id] || {}), ...seller };
    save(data);
    return data.sellers[seller.id];
  },
  getSeller(id) {
    return load().sellers[id] || null;
  },
  upsertOrder(order) {
    const data = load();
    data.orders[order.id] = { ...(data.orders[order.id] || {}), ...order };
    save(data);
    return data.orders[order.id];
  },
  getOrder(id) {
    return load().orders[id] || null;
  },
  listOrders() {
    return Object.values(load().orders);
  },
};
```

### server.js

```js
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
```

### platform-payout.js

The gotcha. Your platform account pays out to your own bank automatically (daily by default), and Stripe doesn't know that most of that balance belongs to sellers. On day 2 the whole balance goes to your bank; on day 3 your release transfer finds an empty balance and fails, or pushes your balance negative.

Fix: **Dashboard → Settings → Payouts → set your platform's schedule to Manual**, then run this on a schedule. It pays you only the part of the available balance that isn't owed to a seller.

```js
require('dotenv').config();
const Stripe = require('stripe');
const db = require('./db');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 20);
const CURRENCY = (process.env.PAYOUT_CURRENCY || 'usd').toLowerCase();

async function main() {
  // Everything we are still holding for sellers, in the smallest currency unit.
  const held = db
    .listOrders()
    .filter((o) => ['HELD', 'COMPLETED'].includes(o.status) && o.currency === CURRENCY)
    .reduce((sum, o) => sum + (o.amount - Math.round((o.amount * FEE_PERCENT) / 100)), 0);

  const balance = await stripe.balance.retrieve();
  const available = balance.available.find((b) => b.currency === CURRENCY)?.amount ?? 0;

  const payable = available - held;
  console.log({ available, held, payable });

  if (payable <= 0) return console.log('Nothing to pay out, everything available is owed to sellers.');

  const payout = await stripe.payouts.create(
    { amount: payable, currency: CURRENCY, description: 'Platform payout (net of escrow)' }
  );
  console.log(`Paid out ${payable} ${CURRENCY}: ${payout.id}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

Run with `npm run payout`, ideally from a daily cron after `releaseDueOrders` has run.

---

## Production checklist

Things this example leaves out on purpose:

- **Real database** with transactions. The JSON file is not safe under concurrent requests.
- **Release condition** you actually trust: buyer confirmation, a dispute window, a calendar event, or a combination. "Complete" should not be callable by the seller alone.
- **Auth** on every endpoint. Anyone can call `/orders/:id/complete` here.
- **Platform payout schedule set to manual** and `platform-payout.js` on a cron. Otherwise see the gotcha above.
- **Stripe fee**: on separate charges the platform pays the processing fee. Your `PLATFORM_FEE_PERCENT` needs to cover it, or add the fee to the seller's deduction.
- **Partial refunds**: pass `amount` to `refunds.create` and `createReversal`. The reversal amount must not exceed the original transfer.
- **Disputes**: a chargeback on a HELD order is simple (you still have the money). A chargeback on a RELEASED order needs the same reversal path as a refund. Listen for `charge.dispute.created`.
- **Hold period**: Stripe expects platforms to transfer funds in a reasonable window. Don't park money for months. Check the current Connect docs for any stated maximum in your region.
- **Regulatory**: the funds sit in your Stripe balance, with Stripe as the licensed institution. Whether your platform needs its own authorisation or an exemption depends on your country (EU, UK and US differ) and how much control you exercise over the funds. Not legal advice. Ask a lawyer before holding meaningful amounts.
- **Accounts v2**: same pattern. `transfers` capability becomes `stripe_balance.stripe_transfers`, and the account-creation calls differ. Transfers, refunds and reversals are unchanged.

---

## The other two options

### Option 1: a timer on the seller's payout schedule

One setting at account creation (or `accounts.update` later). Money goes to the seller's balance at charge time as usual, but waits `delay_days` before hitting their bank. Nothing to run.

```js
await stripe.accounts.create({
  type: 'express',
  country: 'US',
  email,
  capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
  settings: { payouts: { schedule: { interval: 'daily', delay_days: 7 } } },
});
```

Refund with a destination charge: `stripe.refunds.create({ payment_intent, reverse_transfer: true, refund_application_fee: true })`.

### Option 2: seller's balance, you trigger the payout

Destination charge as normal, but the seller's payouts are `manual`. The 80 sits in *their* balance, labelled as theirs, and only moves to their bank when you say so.

```js
// At account creation
await stripe.accounts.create({
  type: 'express',
  country: 'US',
  email,
  capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
  settings: { payouts: { schedule: { interval: 'manual' } } },
});

// Checkout: a normal destination charge
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [...],
  payment_intent_data: {
    transfer_data: { destination: sellerId },
    application_fee_amount: 2000, // your 20% of a $100 order
  },
  success_url, cancel_url,
});

// When your condition is met: pay out from the seller's balance to their bank
await stripe.payouts.create(
  { amount: 8000, currency: 'usd' },
  { stripeAccount: sellerId, idempotencyKey: `payout-${orderId}` }
);
```

Refunds before the payout: `refunds.create({ payment_intent, reverse_transfer: true, refund_application_fee: true })` pulls the money back out of the seller's balance. Less code than option 3, money is in the seller's name the whole time, and you still control timing. The trade-off is that you're paying out per seller balance, not per order, so you need your own ledger to know which orders a payout covers.

---

## Links

- Video: Stripe Connect Escrow: Hold Funds Until the Job Is Done (2026) (link once published)
- Playlist: Stripe Connect for Marketplaces (Complete 2026 Guide)
- Deferred onboarding example: https://github.com/razz1000/stripe-connect-deferred-onboarding-example-repo
- Stripe docs: [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers), [Transfers](https://docs.stripe.com/api/transfers/create), [Payout schedules](https://docs.stripe.com/connect/manage-payout-schedule)
- Prometora, if you'd rather not run this yourself: https://www.prometora.com

MIT
