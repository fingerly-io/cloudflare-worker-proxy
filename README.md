# Badele Cloudflare Worker Proxy

An auditable first-party ingestion proxy for the Badele browser SDK. It runs in
your Cloudflare account and forwards only Badele identify and deferred-signal
requests. It is not an open proxy and cannot read stored events.

## Manual deployment

1. Copy `wrangler.toml.example` to `wrangler.toml` and choose a neutral Worker
   name and route. Avoid blocked words such as `fingerprint`, `tracking`, or
   `badele` in the public path.
2. Set `BADELE_ROUTE_PREFIX` to the path before `/api/v1` and set
   `BADELE_ALLOWED_ORIGINS` to the exact comma-separated website origins.
3. Run `pnpm wrangler secret put BADELE_PROXY_KEY` and paste the `bd_px_...`
   credential shown once by the Badele dashboard.
4. Run `pnpm deploy`.
5. Configure the browser SDK with the route base:

```ts
await load({
  apiKey: 'bd_pk_eu_production_...',
  endpoints: '/your-neutral-path',
  // Optional. Omit this to keep all traffic on the first-party route.
  fallbackToDefaultEndpoint: true,
})
```

The proxy credential encodes the residency region. The Worker only maps `eu`
to `https://eu.api.badele.io` and `us` to `https://us.api.badele.io`; arbitrary
upstreams are impossible. Badele's persistent data remains in that regional
data plane. Cloudflare edge processing location is controlled by your
Cloudflare account and Data Localization configuration.

The Worker strips cookies and authorization headers, overwrites all trusted
visitor metadata, refuses unknown routes, caps request bodies, never follows
upstream redirects, and never logs bodies or credentials.
Open-source first-party Cloudflare Worker proxy for Badele browser identification
