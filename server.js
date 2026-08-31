const express = require('express');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 10000;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const EXPECTED_PRICE_ID = 'price_1U8li3Ek0hZiSTYiwdbIa9Zx';
const PRODUCT_URL = 'https://raw.githubusercontent.com/tnth5g25yf-pixel/fitterfield/main/FitterField-Website-Render-Ready.zip';

app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({ ok: true, stripeConfigured: Boolean(STRIPE_SECRET_KEY) });
});

app.get('/success', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!STRIPE_SECRET_KEY) return res.status(503).send('Delivery service is waiting for its Stripe secret key.');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).send('Invalid checkout session.');

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });

    const paid = session.payment_status === 'paid';
    const amountOk = session.amount_total === 2999 && session.currency === 'usd';
    const priceOk = session.line_items?.data?.some(item => item.price?.id === EXPECTED_PRICE_ID);

    if (!paid || !amountOk || !priceOk) {
      return res.status(403).send('This purchase could not be verified.');
    }

    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>FitterField — Purchase Complete</title><style>body{margin:0;font-family:Arial,sans-serif;background:#0b1220;color:#fff;display:grid;place-items:center;min-height:100vh}.box{max-width:620px;margin:24px;padding:40px;border-radius:20px;background:#121c2f;text-align:center}h1{margin-top:0}p{color:#c9d2e3;line-height:1.6}.btn{display:inline-block;margin-top:18px;padding:15px 24px;border-radius:10px;background:#fff;color:#111;text-decoration:none;font-weight:700}</style></head><body><main class="box"><div style="font-size:42px">✓</div><h1>Welcome to FitterField™</h1><p>Your $29.99 purchase has been verified.</p><p>Your FitterField toolkit is ready.</p><a class="btn" href="/download?session_id=${encodeURIComponent(sessionId)}">Access FitterField</a></main></body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to verify this purchase right now.');
  }
});

app.get('/download', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!STRIPE_SECRET_KEY) return res.status(503).send('Delivery service is not configured.');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).send('Invalid checkout session.');

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    const paid = session.payment_status === 'paid';
    const amountOk = session.amount_total === 2999 && session.currency === 'usd';
    const priceOk = session.line_items?.data?.some(item => item.price?.id === EXPECTED_PRICE_ID);
    if (!paid || !amountOk || !priceOk) return res.status(403).send('Purchase verification failed.');

    const upstream = await fetch(PRODUCT_URL);
    if (!upstream.ok) return res.status(502).send('Product file is temporarily unavailable.');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="FitterField-Website-Render-Ready.zip"');
    res.setHeader('Cache-Control', 'private, no-store');
    upstream.body.pipeTo(new WritableStream({
      write(chunk) { res.write(Buffer.from(chunk)); },
      close() { res.end(); },
      abort() { res.end(); }
    })).catch(() => res.end());
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to deliver the product right now.');
  }
});

app.listen(PORT, () => console.log(`FitterField delivery API listening on ${PORT}`));
