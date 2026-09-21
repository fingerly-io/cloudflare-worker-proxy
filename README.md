# Fingerly Cloudflare Worker Proxy

An auditable first-party ingestion proxy for the Fingerly browser SDK. It runs in
your Cloudflare account and forwards only Fingerly identify and deferred-signal
requests. It is not an open proxy and cannot read stored events.

## Manual deployment

1. Copy `wrangler.toml.example` to `wrangler.toml` and choose a neutral Worker
   name and route. Avoid blocked words such as `fingerprint`, `tracking`, or
   `fingerly` in the public path.
2. Set `FINGERLY_ROUTE_PREFIX` to the path before `/api/v1` and set
   `FINGERLY_ALLOWED_ORIGINS` to the exact comma-separated website origins.
3. Run `pnpm wrangler secret put FINGERLY_PROXY_KEY` and paste the `fly_px_...`
   credential shown once by the Fingerly dashboard.
4. Run `pnpm deploy`.
5. Configure the browser SDK with the route base:

```ts
await load({
  apiKey: 'fly_pk_production_...',
  endpoints: '/your-neutral-path',
  // Optional. Omit this to keep all traffic on the first-party route.
  fallbackToDefaultEndpoint: true,
})
```

The upstream is a constant in the Worker's source: `https://api.fingerly.io`,
and nothing in the configuration can change it. A `FINGERLY_PROXY_KEY` that is
not shaped like a proxy key makes the Worker answer `503` rather than forward
anywhere. Arbitrary upstreams are impossible by construction, not by
validation. Cloudflare edge processing location is controlled by your
Cloudflare account and Data Localization configuration.

The Worker strips cookies and authorization headers, overwrites all trusted
visitor metadata, refuses unknown routes, caps request bodies, never follows
upstream redirects, and never logs bodies or credentials.
Open-source first-party Cloudflare Worker proxy for Fingerly browser identification
