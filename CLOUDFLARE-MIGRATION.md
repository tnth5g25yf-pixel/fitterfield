# FitterField → Cloudflare migration

This branch (`cloudflare-migration`) is the safe migration path from Render.

## Architecture

- Cloudflare Workers + static assets: FitterField web app
- Cloudflare Worker: API layer
- Neon PostgreSQL: persistent application data
- Stripe: subscriptions/payments
- OpenAI: FitterField AI and transcription
- GitHub: source control

## Current phase

Phase 1 is intentionally non-destructive: the existing FitterField `app-v2` code is preserved, while Cloudflare deployment files are added. The existing Render services are not deleted or changed by this branch.

## Cloudflare setup

1. Create/sign into a Cloudflare account.
2. Open **Workers & Pages → Create → Workers**.
3. Connect the `tnth5g25yf-pixel/fitterfield` GitHub repository.
4. Select branch `cloudflare-migration`.
5. Use the repository `wrangler.toml` configuration.
6. Deploy.
7. Verify `/api/health` returns JSON with `ok: true` and `platform: "cloudflare"`.

## Important

Do not delete the Render app or database yet. Stripe, AI, and database routes still need to be cut over and verified before Render is retired.

## Next migration phases

1. Provision Neon PostgreSQL and migrate any existing FitterField data.
2. Move Stripe API routes from Express to the Worker using Stripe's HTTPS API.
3. Move FitterField AI/transcription behind a Worker API route while keeping the OpenAI secret server-side.
4. Point the browser app at same-origin `/api/*` endpoints.
5. Add authentication/rate limiting before opening AI endpoints publicly.
6. Test payments, subscriptions, AI, microphone transcription, database persistence, and mobile behavior.
7. Only after successful verification, retire Render.
