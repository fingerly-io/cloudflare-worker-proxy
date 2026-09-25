# Fingerly Cloudflare Worker Proxy

An auditable first-party proxy for the Fingerly browser SDK. It runs in your
Cloudflare account, on your site's own host, at one path the Fingerly dashboard
issued, and forwards only the browser SDK's submissions. It is not an open proxy
and cannot read stored events.

## Why it gets past content blockers

Blockers refuse requests by URL: a third-party host, a path they know, a word
such as `fingerprint`. Through this Worker the SDK posts to a path on your own
site that is random, unique to you, and has nothing appended to it, so there is
no pattern shared with any other site for a filter list to match. Nothing in the
response names Fingerly either: the Worker relays only `content-type`,
`x-request-id` and the rate limit headers.

## Deployment

1. In the dashboard, open **Integration > Proxy keys**, create a proxy of type
   Cloudflare Worker and copy the key it shows once. Note the path it issued,
   such as `/k7x2qm4a`.
2. Copy `wrangler.toml.example` to `wrangler.toml`. Set the route to that path on
   your site's host and `FINGERLY_PATH` to the same path.
3. Run `pnpm wrangler secret put FINGERLY_PROXY_KEY` and paste the key.
4. Run `pnpm run deploy`.
5. Point the browser SDK at the path:

```ts
await load({
  apiKey: 'fly_pk_production_...',
  endpoints: '/k7x2qm4a',
  consent: 'granted', // only once the visitor has agreed, or you have another lawful basis
  // Optional. Omit this to keep all traffic on your own site.
  fallbackToDefaultEndpoint: true,
})
```

If the route has to live on another host, such as `edge.example.com` serving
pages on `www.example.com`, list the page origins in `FINGERLY_ALLOWED_ORIGINS`
and use the full URL in `endpoints`.

## What it will and will not do

The upstream is a constant in the Worker's source,
`https://api.fingerly.io/api/v1/ingest`, and nothing in the configuration can
change it. A `FINGERLY_PROXY_KEY` that is not shaped like a proxy key makes the
Worker answer `503` rather than forward anywhere. Arbitrary upstreams are
impossible by construction, not by validation.

The Worker strips cookies and authorization headers, sends the visitor's
address from `CF-Connecting-IP`, refuses every other path and method, caps
request bodies at 1 MiB, never follows upstream redirects, and never logs
bodies or credentials. It reports itself upstream as `cloudflare-worker/0.2.0`,
which is how the dashboard shows the version each proxy runs.

Cloudflare edge processing location is controlled by your Cloudflare account and
Data Localization configuration.
