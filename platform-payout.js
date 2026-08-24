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
