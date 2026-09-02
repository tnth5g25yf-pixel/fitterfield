const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

/*
 * STEP 1 — Configuration
 *
 * Never hard-code a Stripe secret key in source control.
 * Add STRIPE_SECRET_KEY to Render > Environment.
 *
 * Helpful failure behavior is used throughout this sample: the server can boot
 * without secrets, but Stripe endpoints return a clear configuration error.
 */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_V2_WEBHOOK_SECRET = process.env.STRIPE_V2_WEBHOOK_SECRET;
const CONNECT_SUBSCRIPTION_PRICE_ID = process.env.CONNECT_SUBSCRIPTION_PRICE_ID || 'price_1UB5dZEk0hZiSTYibNQshVrz';
const CONNECT_APPLICATION_FEE_BPS = Number(process.env.CONNECT_APPLICATION_FEE_BPS || 500); // 500 = 5%.
const EXPECTED_PRICE_ID = 'price_1UAbIhEk0hZiSTYiYiamGCoH';
const PRODUCT_URL = 'https://raw.githubusercontent.com/tnth5g25yf-pixel/fitterfield/main/FitterField-Website-Render-Ready.zip';

// STEP 2 — Use ONE Stripe Client for every Stripe request.
// Do not set an apiVersion here; stripe-node uses its SDK-default API version.
const stripeClient = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/*
 * STEP 3 — Optional Postgres persistence.
 *
 * The Render Postgres database is already available for FitterField. When
 * DATABASE_URL is present, we persist the demo user's email -> Stripe account
 * mapping and subscription status. If it is absent, the demo falls back to an
 * in-memory Map so the UI can still be previewed; that fallback is not durable.
 */
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
const memoryUsers = new Map();

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL is missing. Connect user mappings will be in-memory only. Add DATABASE_URL in Render for persistence.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS connect_users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      stripe_account_id TEXT UNIQUE,
      subscription_status TEXT,
      subscription_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function saveUser({ email, displayName, accountId }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!pool) {
    const existing = memoryUsers.get(normalizedEmail) || {};
    const user = { ...existing, email: normalizedEmail, displayName, accountId };
    memoryUsers.set(normalizedEmail, user);
    return user;
  }
  const result = await pool.query(
    `INSERT INTO connect_users (email, display_name, stripe_account_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       stripe_account_id = COALESCE(EXCLUDED.stripe_account_id, connect_users.stripe_account_id),
       updated_at = NOW()
     RETURNING *`,
    [normalizedEmail, displayName, accountId || null]
  );
  return result.rows[0];
}

async function findUser(email) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!pool) return memoryUsers.get(normalizedEmail) || null;
  const result = await pool.query('SELECT * FROM connect_users WHERE email = $1 LIMIT 1', [normalizedEmail]);
  return result.rows[0] || null;
}

async function findUserByAccount(accountId) {
  if (!pool) {
    return [...memoryUsers.values()].find(user => user.accountId === accountId) || null;
  }
  const result = await pool.query('SELECT * FROM connect_users WHERE stripe_account_id = $1 LIMIT 1', [accountId]);
  return result.rows[0] || null;
}

async function saveSubscription(accountId, status, subscriptionId) {
  const user = await findUserByAccount(accountId);
  if (!user) return;
  if (!pool) {
    user.subscriptionStatus = status;
    user.subscriptionId = subscriptionId;
    return;
  }
  await pool.query(
    `UPDATE connect_users SET subscription_status = $1, subscription_id = $2, updated_at = NOW()
     WHERE stripe_account_id = $3`,
    [status, subscriptionId || null, accountId]
  );
}

function requireStripe(res) {
  if (!stripeClient) {
    res.status(503).json({
      error: 'Stripe is not configured.',
      fix: 'Add STRIPE_SECRET_KEY to the FitterField Pro Render service environment variables. Never put the secret key in HTML or GitHub.'
    });
    return false;
  }
  return true;
}

function requireBaseUrl(res) {
  if (!process.env.APP_BASE_URL) {
    res.status(503).json({
      error: 'APP_BASE_URL is not configured.',
      fix: 'Add APP_BASE_URL to Render, for example https://fitterfield-pro-app.onrender.com.'
    });
    return false;
  }
  return true;
}

function validAccountId(value) {
  return /^acct_[A-Za-z0-9]+$/.test(String(value || ''));
}

function publicAccountStatus(account) {
  const capabilityStatus = account?.configuration?.merchant?.capabilities?.card_payments?.status || 'unknown';
  const requirementsStatus = account?.requirements?.summary?.minimum_deadline?.status || 'unknown';
  const onboardingComplete = !['currently_due', 'past_due'].includes(requirementsStatus);
  return {
    accountId: account.id,
    readyToProcessPayments: capabilityStatus === 'active',
    capabilityStatus,
    requirementsStatus,
    onboardingComplete,
    displayName: account.display_name || null,
    contactEmail: account.contact_email || null
  };
}

/*
 * IMPORTANT: Stripe webhook signature verification needs the raw request body.
 * This route MUST appear before express.json().
 */
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeClient) return res.status(503).send('Stripe is not configured. Add STRIPE_SECRET_KEY in Render.');
  if (!STRIPE_WEBHOOK_SECRET) return res.status(503).send('STRIPE_WEBHOOK_SECRET is missing. Add the normal Stripe webhook signing secret in Render.');

  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Normal webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // These are normal (non-thin) Billing webhooks.
    switch (event.type) {
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const accountId = subscription.customer_account;
        if (accountId) await saveSubscription(accountId, subscription.status, subscription.id);
        console.log('Subscription updated:', subscription.id, subscription.status);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const accountId = subscription.customer_account;
        if (accountId) await saveSubscription(accountId, 'canceled', subscription.id);
        console.log('Subscription deleted:', subscription.id);
        break;
      }
      case 'payment_method.attached':
        console.log('Payment method attached:', event.data.object.id);
        break;
      case 'payment_method.detached':
        console.log('Payment method detached:', event.data.object.id);
        break;
      case 'customer.updated':
        console.log('Customer billing information changed:', event.data.object.id);
        break;
      case 'customer.tax_id.created':
      case 'customer.tax_id.deleted':
      case 'customer.tax_id.updated':
      case 'billing_portal.configuration.created':
      case 'billing_portal.configuration.updated':
      case 'billing_portal.session.created':
        console.log(`Received ${event.type}`);
        break;
      default:
        console.log(`Unhandled normal Stripe event: ${event.type}`);
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler failed:', err);
    return res.status(500).send('Webhook handler failed.');
  }
});

/*
 * STEP 4 — V2 thin-event webhook.
 *
 * Thin events are intentionally tiny and unversioned. We verify the signature,
 * parse the thin event, retrieve the full V2 event, then retrieve the current
 * Account state using the related_object.id. This keeps requirements/capability
 * data current instead of trusting a stale webhook snapshot.
 */
app.post('/webhooks/stripe-v2', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeClient) return res.status(503).send('Stripe is not configured. Add STRIPE_SECRET_KEY in Render.');
  if (!STRIPE_V2_WEBHOOK_SECRET) return res.status(503).send('STRIPE_V2_WEBHOOK_SECRET is missing. Add the thin-event destination signing secret in Render.');

  try {
    const signature = req.headers['stripe-signature'];
    const thinEvent = stripeClient.parseThinEvent(req.body, signature, STRIPE_V2_WEBHOOK_SECRET);
    const event = await stripeClient.v2.core.events.retrieve(thinEvent.id);
    const accountId = event?.related_object?.id;

    if (!accountId || !validAccountId(accountId)) {
      console.warn('V2 event had no valid related Account ID:', event?.type);
      return res.json({ received: true });
    }

    // These handlers intentionally cover each event requested for this demo.
    switch (event.type) {
      case 'v2.core.account[requirements].updated':
        await collectUpdatedRequirements(accountId, event);
        break;
      case 'v2.core.account[configuration.merchant].capability_status_updated':
        await collectUpdatedRequirements(accountId, event);
        break;
      case 'v2.core.account[configuration.customer].capability_status_updated':
        await collectUpdatedRequirements(accountId, event);
        break;
      case 'v2.core.account[configuration.recipient].capability_status_updated':
        await collectUpdatedRequirements(accountId, event);
        break;
      default:
        console.log('Unhandled V2 thin event:', event.type);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('V2 thin webhook error:', err.message);
    return res.status(400).send('Invalid V2 thin event.');
  }
});

async function collectUpdatedRequirements(accountId, event) {
  // Fetch current state directly from Stripe. We do NOT store onboarding status.
  const account = await stripeClient.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.merchant', 'requirements']
  });
  const status = publicAccountStatus(account);
  console.log('Fresh Connect status after', event.type, status);
  return status;
}

// JSON parsing is intentionally after the webhook routes.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));

/* ----------------------------- Demo UI routes ----------------------------- */
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/connect', (_req, res) => res.sendFile(path.join(__dirname, 'connect.html')));
app.get('/store/:accountId', (_req, res) => res.sendFile(path.join(__dirname, 'connect.html')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    stripeConfigured: Boolean(STRIPE_SECRET_KEY),
    databaseConfigured: Boolean(pool),
    stripeSdk: '22.4.0+',
    connect: 'v2',
    billing: 'monthly',
    app: 'fitterfield-connect-demo'
  });
});

/* -------------------------- Connected Accounts ---------------------------- */

// STEP 5 — Create a V2 connected account.
// IMPORTANT: no top-level `type` field is used. The requested V2 properties are
// intentionally the only account-creation properties in this sample.
app.post('/api/connect/accounts', async (req, res) => {
  if (!requireStripe(res) || !requireBaseUrl(res)) return;

  const displayName = String(req.body.displayName || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!displayName || !email) return res.status(400).json({ error: 'Display name and email are required.' });

  try {
    const account = await stripeClient.v2.core.accounts.create({
      display_name: displayName,
      contact_email: email,
      identity: {
        country: 'us'
      },
      dashboard: 'full',
      defaults: {
        responsibilities: {
          fees_collector: 'stripe',
          losses_collector: 'stripe'
        }
      },
      configuration: {
        customer: {},
        merchant: {
          capabilities: {
            card_payments: {
              requested: true
            }
          }
        }
      }
    });

    // Map the application user to the Stripe account ID in Postgres.
    await saveUser({ email, displayName, accountId: account.id });
    res.json({ accountId: account.id, message: 'Connected account created.' });
  } catch (err) {
    console.error('Account creation failed:', err);
    res.status(500).json({ error: err.message || 'Unable to create connected account.' });
  }
});

// STEP 6 — Create an Account Link for onboarding.
app.post('/api/connect/accounts/:accountId/onboarding', async (req, res) => {
  if (!requireStripe(res) || !requireBaseUrl(res)) return;
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).json({ error: 'Invalid connected account ID.' });

  try {
    const accountLink = await stripeClient.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant', 'customer'],
          refresh_url: `${APP_BASE_URL}/connect?accountId=${encodeURIComponent(accountId)}&refresh=1`,
          return_url: `${APP_BASE_URL}/connect?accountId=${encodeURIComponent(accountId)}&onboarding=returned`
        }
      }
    });
    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('Account Link creation failed:', err);
    res.status(500).json({ error: err.message || 'Unable to create onboarding link.' });
  }
});

// STEP 7 — Always retrieve onboarding/payment status directly from Stripe.
app.get('/api/connect/accounts/:accountId/status', async (req, res) => {
  if (!requireStripe(res)) return;
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).json({ error: 'Invalid connected account ID.' });

  try {
    const account = await stripeClient.v2.core.accounts.retrieve(accountId, {
      include: ['configuration.merchant', 'requirements']
    });
    res.json(publicAccountStatus(account));
  } catch (err) {
    console.error('Account status lookup failed:', err);
    res.status(500).json({ error: err.message || 'Unable to retrieve account status.' });
  }
});

/* ------------------------------ Products --------------------------------- */

// STEP 8 — Create a product on the connected account.
// stripeAccount sets the Stripe-Account header, so the product belongs to the
// connected merchant rather than the FitterField platform account.
app.post('/api/connect/:accountId/products', async (req, res) => {
  if (!requireStripe(res)) return;
  const accountId = req.params.accountId;
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const priceInCents = Number(req.body.priceInCents);
  const currency = String(req.body.currency || 'usd').toLowerCase();

  if (!validAccountId(accountId)) return res.status(400).json({ error: 'Invalid connected account ID.' });
  if (!name) return res.status(400).json({ error: 'Product name is required.' });
  if (!Number.isInteger(priceInCents) || priceInCents < 50) return res.status(400).json({ error: 'Price must be an integer in cents and at least 50 cents.' });
  if (!/^[a-z]{3}$/.test(currency)) return res.status(400).json({ error: 'Currency must be a 3-letter ISO currency code.' });

  try {
    const product = await stripeClient.products.create({
      name,
      description,
      default_price_data: {
        unit_amount: priceInCents,
        currency
      }
    }, { stripeAccount: accountId });
    res.json({ product });
  } catch (err) {
    console.error('Product creation failed:', err);
    res.status(500).json({ error: err.message || 'Unable to create product.' });
  }
});

// STEP 9 — Storefront product list. The connected account ID is in the URL for
// this demo only. In production, use your own merchant slug/database ID and
// resolve it to the Stripe account ID server-side.
app.get('/api/store/:accountId/products', async (req, res) => {
  if (!requireStripe(res)) return;
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).json({ error: 'Invalid connected account ID.' });

  try {
    const products = await stripeClient.products.list({
      limit: 20,
      active: true,
      expand: ['data.default_price']
    }, { stripeAccount: accountId });
    res.json({ products: products.data });
  } catch (err) {
    console.error('Product list failed:', err);
    res.status(500).json({ error: err.message || 'Unable to list products.' });
  }
});

/* -------------------------- Direct Charge Checkout ------------------------ */

// STEP 10 — Hosted Checkout direct charge.
// The Stripe-Account header means the connected account is the merchant of
// record for this direct charge. application_fee_amount monetizes FitterField.
app.post('/api/store/:accountId/checkout', async (req, res) => {
  if (!requireStripe(res) || !requireBaseUrl(res)) return;
  const accountId = req.params.accountId;
  const productId = String(req.body.productId || '');
  if (!validAccountId(accountId)) return res.status(400).json({ error: 'Invalid connected account ID.' });
  if (!/^prod_[A-Za-z0-9]+$/.test(productId)) return res.status(400).json({ error: 'Invalid product ID.' });

  try {
    // Read the product from the connected account, not the platform account.
    const product = await stripeClient.products.retrieve(productId, { expand: ['default_price'] }, { stripeAccount: accountId });
    const defaultPrice = product.default_price;
    const unitAmount = Number(defaultPrice?.unit_amount);
    if (!Number.isInteger(unitAmount)) throw new Error('The selected product does not have a fixed default price.');

    const applicationFee = Math.max(1, Math.floor(unitAmount * (CONNECT_APPLICATION_FEE_BPS / 10000)));
    const session = await stripeClient.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: defaultPrice.currency,
          product_data: {
            name: product.name,
            description: product.description || undefined
          },
          unit_amount: unitAmount
        },
        quantity: 1
      }],
      payment_intent_data: {
        application_fee_amount: applicationFee
      },
      mode: 'payment',
      success_url: `${APP_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/store/${encodeURIComponent(accountId)}`
    }, { stripeAccount: accountId });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Direct-charge Checkout creation failed:', err);
    res.status(500).json({ error: err.message || 'Unable to start Checkout.' });
  }
});

/* -------------------------- Connected Account SaaS ------------------------ */

// STEP 11 — Subscription Checkout for a connected account.
// The platform-level recurring price was created in Stripe test mode for this
// demo: price_1UB5dZEk0hZiSTYibNQshVrz. Set CONNECT_SUBSCRIPTION_PRICE_ID in
// Render to use a different price. The V2 account ID doubles as customer_account.
app.post('/api/connect/:accountId/subscription', async (req, res) => {
  if (!requireStripe(res) || !requireBaseUrl(res)) return;
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).json({ error: 'Invalid connected account ID.' });
  if (!CONNECT_SUBSCRIPTION_PRICE_ID || CONNECT_SUBSCRIPTION_PRICE_ID.startsWith('price_PLACEHOLDER')) {
    return res.status(503).json({ error: 'CONNECT_SUBSCRIPTION_PRICE_ID is missing.', fix: 'Create a recurring platform Price in Stripe and set CONNECT_SUBSCRIPTION_PRICE_ID in Render.' });
  }

  try {
    const session = await stripeClient.checkout.sessions.create({
      customer_account: accountId,
      mode: 'subscription',
      line_items: [{ price: CONNECT_SUBSCRIPTION_PRICE_ID, quantity: 1 }],
      success_url: `${APP_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/connect?accountId=${encodeURIComponent(accountId)}`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Connected-account subscription Checkout failed:', err);
    res.status(500).json({ error: err.message || 'Unable to start subscription Checkout.' });
  }
});

// STEP 12 — Billing Portal lets the connected account manage its subscription.
app.post('/api/connect/:accountId/portal', async (req, res) => {
  if (!requireStripe(res) || !requireBaseUrl(res)) return;
  const accountId = req.params.accountId;
  if (!validAccountId(accountId)) return res.status(400).json({ error: 'Invalid connected account ID.' });

  try {
    const session = await stripeClient.billingPortal.sessions.create({
      customer_account: accountId,
      return_url: `${APP_BASE_URL}/connect?accountId=${encodeURIComponent(accountId)}`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Billing Portal session failed:', err);
    res.status(500).json({ error: err.message || 'Unable to open Billing Portal.' });
  }
});

/* ----------------------------- Legacy Pro flow ---------------------------- */

async function getVerifiedSubscription(sessionId) {
  if (!stripeClient) throw new Error('Stripe is not configured. Add STRIPE_SECRET_KEY.');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  const session = await stripeClient.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  if (session.mode !== 'subscription' || !session.subscription) return null;
  const priceOk = session.line_items?.data?.some(item => item.price?.id === EXPECTED_PRICE_ID);
  if (!priceOk) return null;
  const subscription = await stripeClient.subscriptions.retrieve(session.subscription);
  if (!['active', 'trialing'].includes(subscription.status)) return null;
  return { session, subscription };
}

app.get('/success', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!stripeClient) return res.status(503).send('Stripe is not configured. Add STRIPE_SECRET_KEY in Render.');
  try {
    const verified = await getVerifiedSubscription(sessionId);
    if (!verified) return res.status(403).send('This FitterField subscription could not be verified.');
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>FitterField — Payment Complete</title><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#071525;color:#fff;display:grid;place-items:center;min-height:100vh}.box{max-width:620px;margin:24px;padding:40px;border-radius:20px;background:#10253b;text-align:center}.btn{display:inline-block;margin-top:18px;padding:15px 24px;border-radius:10px;background:#ff8a25;color:#111;text-decoration:none;font-weight:700}</style></head><body><main class="box"><div style="font-size:48px">✓</div><h1>Payment complete</h1><p>Your FitterField Stripe flow completed successfully.</p><a class="btn" href="/app">Open FitterField</a></main></body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to verify the payment right now.');
  }
});

app.get('/download', async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!stripeClient) return res.status(503).send('Stripe is not configured.');
  try {
    const verified = await getVerifiedSubscription(sessionId);
    if (!verified) return res.status(403).send('Active FitterField Pro subscription required.');
    const upstream = await fetch(PRODUCT_URL);
    if (!upstream.ok) return res.status(502).send('Product file is temporarily unavailable.');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="FitterField-Website-Render-Ready.zip"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to deliver the product right now.');
  }
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`FitterField Connect app listening on ${PORT}`)))
  .catch(err => {
    console.error('Database initialization failed:', err);
    app.listen(PORT, () => console.log(`FitterField Connect app listening on ${PORT} without database initialization`));
  });
