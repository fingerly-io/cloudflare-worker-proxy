# Fingerly Cloudflare Worker Proxy

An auditable first-party proxy for Fingerly browser and native SDKs. It runs in
your Cloudflare account, on your site's own host, at one path the Fingerly
dashboard issued, and forwards single-pass raw-byte ingest submissions. It is
not an open proxy and cannot read stored events.

## Why it gets past content blockers

Blockers refuse requests by URL: a third-party host, a path they know, a word
such as `fingerprint`. Through this Worker the SDK posts to a path on your own
site that is random, unique to you, and has nothing appended to it, so there is
no pattern shared with any other site for a filter list to match. Nothing in the
response names Fingerly either: the Worker relays only `content-type`,
`x-request-id`, the rate limit headers and `retry-after`.

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
`https://api.fingerly.io/api/v1/ingest`. Any subpath or trailing slash under the
issued path answers `404` marked `no-store`. The one exception for the
upstream is testing on your own machine: `FINGERLY_DEV_UPSTREAM`, such as
`http://localhost:8080`, is honoured only when it names a loopback origin
(`localhost`, `127.0.0.1` or `[::1]`), so a deployed Worker cannot be pointed
anywhere else. A `FINGERLY_PROXY_KEY` that is not shaped like a proxy key makes
the Worker answer `503` rather than forward anywhere.

Incoming headers follow a sanitize-and-restore sequence: the Worker captures
`x-fingerly-sdk-platform` only when it matches the exact lowercase native SDK
allowlist, strips every incoming `x-fingerly-*` header alongside `Cookie` and
`Authorization`, restores the validated `x-fingerly-sdk-platform` only when it
matched and `Origin` is absent (a request with `Origin` goes upstream with
`x-fingerly-origin` only: one channel header, never both), and rejects with `400` (`missing_origin`, marked `no-store`) when both `Origin`
and validated `x-fingerly-sdk-platform` are absent (never synthesizing
`x-fingerly-origin` from the request URL or `Host`).

The Worker forwards raw request body bytes untouched (capped at 1 MiB), sends
the visitor's address from `CF-Connecting-IP` (answering `500` when that header
does not hold one IP address), forwards allowlisted client headers
(`x-api-key`, `content-type`, `idempotency-key`, `user-agent`, `sec-fetch-*`
and `sec-ch-ua*`), and forwards one value from `request.cf`: the JA4 TLS
fingerprint in `request.cf.botManagement.ja4`, sent as `x-fingerly-edge-ja4`
only when Cloudflare provides it and it is shaped like JA4. Cloudflare provides
JA4 only on Enterprise plans with Bot Management; on any other plan the header
is not sent. The edge's TLS version, cipher and HTTP protocol cannot tell a
current browser from a script, so they are not sent. Any `x-fingerly-*` header
the client sends, `x-fingerly-edge-ja4` included, is dropped. A request whose `x-api-key` is
missing or is not a `fly_pk_` public key of the proxy key's environment (a
secret `fly_sk_` key included) answers `401` before any upstream call. Every
other HTTP method answers
`405` with `Allow: POST`. One 5-second deadline covers the whole upstream
exchange. The answer is read in full, up to 4 MiB, before anything is sent
back: a timeout answers `504`, and an unreachable upstream, a broken answer or
one over the cap answers `502`, each marked `no-store`. Redirects are never
followed: an upstream `3xx`, or any status outside `200` to `599`, answers
`502` marked `no-store`, and its `Location` is never relayed. It reports itself
upstream as `cloudflare-worker/0.3.0`, which is how the dashboard shows the
version each proxy runs.

Cloudflare edge processing location is controlled by your Cloudflare account and
Data Localization configuration.

## Testing locally

Copy the configuration, set `FINGERLY_PATH` in it and drop the routes line.
Then write `.dev.vars` (gitignored), readable only by you, from a prompt. The
prompt does not echo: paste a development proxy key and press Enter. It never
appears on a command line, so it stays out of your shell history and the
process list:

```sh
cp wrangler.toml.example wrangler.toml
install -m 600 /dev/null .dev.vars
printf 'Proxy key: ' && read -rs proxy_key && echo &&
  printf 'FINGERLY_PROXY_KEY=%s\nFINGERLY_DEV_UPSTREAM=http://localhost:8080\n' "$proxy_key" > .dev.vars; unset proxy_key
```

Then start the Worker:

```sh
pnpm wrangler dev --local
```
