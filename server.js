const express = require('express');
const Stripe = require('stripe');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const EXPECTED_PRICE_ID = 'price_1UAbIhEk0hZiSTYiYiamGCoH';
const PRODUCT_URL = 'https://raw.githubusercontent.com/tnth5g25yf-pixel/fitterfield/main/FitterField-Website-Render-Ready.zip';

app.disable('x-powered-by');

// Product app: served from the same origin so the Pro experience has a clean home.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, stripeConfigured: Boolean(STRIPE_SECRET_KEY), billing: 'monthly', priceId: EXPECTED_PRICE_ID, app: 'fitterfield-pro-v1' });
});

async function getVerifiedSubscription(sessionId) {
  if (!STRIPE_SECRET_KEY) throw new Error('Stripe is not configured');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  if (session.mode !== 'subscription' || !session.subscription) return null;

  const priceOk = session.line_items?.data?.some(item => item.price?.id === EXPECTED_PRICE_ID);
  if (!priceOk) return null;

  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  const active = ['active', 'trialing'].includes(subscription.status);
  if (!active) return null;

  return { stripe, session, subscription };
}

app.get('/success', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!STRIPE_SECRET_KEY) return res.status(503).send('Delivery service is waiting for its Stripe secret key.');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).send('Invalid checkout session.');

  try {
    const verified = await getVerifiedSubscription(sessionId);
    if (!verified) return res.status(403).send('This FitterField Pro subscription could not be verified.');

    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>FitterField — Pro Active</title><style>body{margin:0;font-family:Arial,sans-serif;background:#071525;color:#fff;display:grid;place-items:center;min-height:100vh}.box{max-width:620px;margin:24px;padding:40px;border-radius:20px;background:#10253b;text-align:center;box-shadow:0 20px 70px #0006}.check{font-size:48px;color:#27d3ee}h1{margin-top:8px}p{color:#c9d2e3;line-height:1.6}.btn{display:inline-block;margin-top:18px;padding:15px 24px;border-radius:10px;background:#ff8a25;color:#111;text-decoration:none;font-weight:700}.small{font-size:12px;color:#8fa4b8;margin-top:22px}</style></head><body><main class="box"><div class="check">✓</div><h1>Welcome to FitterField™ Pro</h1><p>Your monthly Pro membership is active.</p><p>Your FitterField toolkit is ready.</p><a class="btn" href="/app">Open FitterField</a><p class="small">You can manage or cancel your subscription through Stripe.</p></main></body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to verify this subscription right now.');
  }
});

app.get('/download', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!STRIPE_SECRET_KEY) return res.status(503).send('Delivery service is not configured.');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).send('Invalid checkout session.');

  try {
    const verified = await getVerifiedSubscription(sessionId);
    if (!verified) return res.status(403).send('Active FitterField Pro subscription required.');

    const upstream = await fetch(PRODUCT_URL);
    if (!upstream.ok) return res.status(502).send('Product file is temporarily unavailable.');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="FitterField-Website-Render-Ready.zip"');
    res.setHeader('Cache-Control', 'private, no-store');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to deliver the product right now.');
  }
});

app.listen(PORT, () => console.log(`FitterField Pro app listening on ${PORT}`));
