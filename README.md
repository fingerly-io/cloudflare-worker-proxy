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
  apiKey: 'fly_pk_eu_production_...',
  endpoints: '/your-neutral-path',
  // Optional. Omit this to keep all traffic on the first-party route.
  fallbackToDefaultEndpoint: true,
})
```

The proxy credential encodes the residency region. The Worker only maps `eu`
to `https://eu.api.fingerly.io` and `us` to `https://us.api.fingerly.io`; arbitrary
upstreams are impossible. Fingerly's persistent data remains in that regional
data plane. Cloudflare edge processing location is controlled by your
Cloudflare account and Data Localization configuration.

The Worker strips cookies and authorization headers, overwrites all trusted
visitor metadata, refuses unknown routes, caps request bodies, never follows
upstream redirects, and never logs bodies or credentials.
Open-source first-party Cloudflare Worker proxy for Fingerly browser identification
