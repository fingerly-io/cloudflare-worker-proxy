<p align="center">
  <a href="https://fingerly.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fingerly-io/.github/main/assets/logo-dark.svg">
      <img src="https://raw.githubusercontent.com/fingerly-io/.github/main/assets/logo-light.svg" alt="Fingerly" height="44">
    </picture>
  </a>
</p>

<p align="center"><b>Fingerly Cloudflare Worker Proxy</b><br>An auditable first-party proxy that serves the Fingerly browser SDK from a path on your own site, so content blockers have nothing to match.</p>

<p align="center">
  <a href="https://github.com/fingerly-io/cloudflare-worker-proxy/releases"><img src="https://img.shields.io/github/v/release/fingerly-io/cloudflare-worker-proxy?style=flat-square" alt="Latest release"></a>
  <a href="https://github.com/fingerly-io/cloudflare-worker-proxy/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/fingerly-io/cloudflare-worker-proxy/release.yml?branch=main&style=flat-square&label=release" alt="Release workflow"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/fingerly-io/cloudflare-worker-proxy?style=flat-square" alt="License"></a>
  <a href="https://docs.fingerly.io/docs/sdks/cloudflare-worker"><img src="https://img.shields.io/badge/docs-docs.fingerly.io-blue?style=flat-square" alt="Documentation"></a>
</p>

<p align="center"><img src="https://raw.githubusercontent.com/fingerly-io/.github/main/assets/banner.webp" alt="Fingerly" width="100%"></p>

## What is this

An auditable first-party proxy for the Fingerly browser SDK. It runs in your Cloudflare account,
on your site's own host, at one path the Fingerly dashboard issued, and forwards only the browser
SDK's submissions. It is not an open proxy and cannot read stored events.
[Fingerly](https://fingerly.io) is device intelligence for fraud prevention.

- [Why it gets past content blockers](#why-it-gets-past-content-blockers)
- [Getting started](#getting-started)
- [What it will and will not do](#what-it-will-and-will-not-do)
- [Configuration](#configuration)
- [Testing locally](#testing-locally)
- [Requirements](#requirements)
- [Documentation](#documentation)
- [Help](#help)
- [Licence](#licence)

## Why it gets past content blockers

Blockers refuse requests by URL: a third-party host, a path they know, a word such as
`fingerprint`. Through this Worker the SDK posts to a path on your own site that is random, unique
to you, and has nothing appended to it, so there is no pattern shared with any other site for a
filter list to match. Nothing in the response names Fingerly either: the Worker relays only
`content-type`, `x-request-id`, the rate limit headers and `retry-after`.

## Getting started

1. Prerequisites: a Fingerly account and a Cloudflare account that serves your site. In the
   dashboard, open **Integration > Proxy keys**, create a proxy of type Cloudflare Worker and copy
   the key it shows once. Note the path it issued, such as `/k7x2qm4a`. See
   [Proxy integrations](https://docs.fingerly.io/docs/proxy-integrations).
2. Clone this repository, install its dependencies and copy `wrangler.toml.example` to
   `wrangler.toml`. Set the route to that path on your site's host and `FINGERLY_PATH` to the same
   path:

   ```sh
   pnpm install
   cp wrangler.toml.example wrangler.toml
   ```

3. Store the key as a secret and deploy:

   ```sh
   pnpm wrangler secret put FINGERLY_PROXY_KEY   # paste the key when asked
   pnpm run deploy
   ```

4. Point the browser SDK at the path:

   ```ts
   await load({
     apiKey: 'fly_pk_production_...',
     endpoints: '/k7x2qm4a',
     consent: 'granted', // only once the visitor has agreed, or you have another lawful basis
     // Optional. Omit this to keep all traffic on your own site.
     fallbackToDefaultEndpoint: true,
   })
   ```

If the route has to live on another host, such as `edge.example.com` serving pages on
`www.example.com`, list the page origins in `FINGERLY_ALLOWED_ORIGINS` and use the full URL in
`endpoints`.

## What it will and will not do

The upstream is a constant in the Worker's source, `https://api.fingerly.io/api/v1/ingest`. The
one exception is for testing on your own machine: `FINGERLY_DEV_UPSTREAM`, such as
`http://localhost:8080`, is honoured only when it names a loopback origin (`localhost`,
`127.0.0.1` or `[::1]`), so a deployed Worker cannot be pointed anywhere else. A
`FINGERLY_PROXY_KEY` that is not shaped like a proxy key makes the Worker answer `503` rather than
forward anywhere.

The Worker strips cookies and authorization headers, sends the visitor's address from
`CF-Connecting-IP` (and forwards nothing, answering `500`, when that header does not hold one IP
address), answers exactly the issued path and `405` with `Allow: POST` for every other method,
caps request bodies at 1 MiB, never follows upstream redirects, and never logs bodies or
credentials. One 5-second deadline covers the whole upstream exchange. The answer is read in
full, up to 4 MiB, before anything is sent back: a timeout answers `504`, and an unreachable
upstream, a broken answer or one over the cap answers `502`, each as short plain text marked
`no-store`. It reports itself upstream as `cloudflare-worker/0.2.0`, which is how the dashboard
shows the version each proxy runs.

Cloudflare edge processing location is controlled by your Cloudflare account and Data
Localization configuration.

<details>
<summary>Every status the Worker answers</summary>

| Status | When |
| --- | --- |
| `404` | The request is not for exactly the issued path (no trailing slash, nothing under it, case-sensitive) |
| `403` | The page's origin is neither the Worker's own host nor listed in `FINGERLY_ALLOWED_ORIGINS` |
| `204` | An `OPTIONS` preflight, with `Allow: POST, OPTIONS` |
| `405` | Any other method than `POST`, with `Allow: POST` |
| `503` | `FINGERLY_PROXY_KEY` is not shaped like a proxy key |
| `401` | The request carries no `x-api-key` header |
| `500` | `CF-Connecting-IP` does not hold exactly one IPv4 or IPv6 address (logged once per isolate) |
| `413` | The request body is over 1 MiB |
| `504` | The upstream exchange passed the 5-second deadline |
| `502` | The upstream was unreachable, answered with something broken, or answered with more than 4 MiB |
| `499` | The visitor disconnected before the upstream answered |

Anything else is the upstream's own status, relayed with the allowlisted headers only.

</details>

## Configuration

Set in `wrangler.toml` (copied from `wrangler.toml.example`) or as secrets.

| Setting | Required | What it does |
| --- | --- | --- |
| `FINGERLY_PROXY_KEY` | Yes | The proxy key the dashboard issued. Set it as a Worker secret with `pnpm wrangler secret put FINGERLY_PROXY_KEY` |
| `FINGERLY_PATH` | Yes | The path the dashboard issued, such as `/k7x2qm4a`. The browser SDK posts here. Must match the route |
| `FINGERLY_ALLOWED_ORIGINS` | No | Other origins whose pages may post here, comma-separated. Only needed when the Worker answers on a different host from the page |
| `FINGERLY_DEV_UPSTREAM` | No | Local testing only: a loopback API to forward to. Any other value is ignored |

The route is the path the dashboard issued, on your site's own host, exactly that path: the Worker
answers nothing else.

## Testing locally

Copy the configuration, set `FINGERLY_PATH` in it and drop the routes line. Then write `.dev.vars`
(gitignored), readable only by you, from a prompt. The prompt does not echo: paste a development
proxy key and press Enter. It never appears on a command line, so it stays out of your shell
history and the process list:

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

To run this repository's own checks:

```sh
pnpm run lint
pnpm test
```

## Requirements

- A Cloudflare account with the site's zone, and Wrangler 4 (installed by `pnpm install`).
- Node.js and pnpm to deploy and test. CI uses Node.js 22.
- A Fingerly proxy key of type Cloudflare Worker.

## Documentation

- [Cloudflare Worker proxy guide](https://docs.fingerly.io/docs/sdks/cloudflare-worker)
- [Proxy integrations](https://docs.fingerly.io/docs/proxy-integrations)
- [Browser SDK](https://docs.fingerly.io/docs/sdks/javascript)

## Help

Open an issue on this repository, or write to [support@fingerly.io](mailto:support@fingerly.io).
Security issues: [security@fingerly.io](mailto:security@fingerly.io).

## Licence

Apache-2.0, see [LICENSE](LICENSE).
