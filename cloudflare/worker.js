/**
 * FitterField Cloudflare Worker entry point.
 *
 * Phase 1: serve the existing FitterField app from Cloudflare and provide a
 * health endpoint. Backend routes are intentionally not duplicated here yet;
 * Stripe/OpenAI/database migration is completed in later phases so the
 * production app is never left half-migrated.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' || url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'fitterfield-pro',
        platform: 'cloudflare',
        environment: env.FITTERFIELD_ENV || 'unknown'
      });
    }

    return env.ASSETS.fetch(request);
  }
};
