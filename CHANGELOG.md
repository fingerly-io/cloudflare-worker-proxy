# Changelog

## 0.4.0

- Forwards the Web Bot Auth headers `Signature`, `Signature-Input` and
  `Signature-Agent` under their own names, so the API can verify an AI
  agent's signature over `x-fingerly-host`. Each is sent only when present,
  non-empty and at most 4096 bytes as sent; a longer one, which the API
  ignores, is dropped and the request is still forwarded. They stay out of
  the CORS allow list: the agent's browser adds them itself and never
  preflights them.

## 0.3.0

- Answers exactly the issued path: no trailing slash, nothing under it,
  case-sensitive. Only `POST` is forwarded; a 405 carries `Allow: POST`, and
  every refusal is plain text marked `no-store`. An `Origin` that is neither
  the Worker's own nor in `FINGERLY_ALLOWED_ORIGINS` answers 403.
- Answers 503 when `FINGERLY_PROXY_KEY` is missing or is not a proxy key, and
  401 itself unless `X-Api-Key` is a public key of the proxy key's
  environment. A secret key is never forwarded.
- Answers 400 `missing_origin` when a request carries neither `Origin` nor a
  valid `X-Fingerly-SDK-Platform`. Exactly one channel header goes upstream:
  `X-Fingerly-Origin` for a browser, otherwise the validated
  `X-Fingerly-SDK-Platform` for a native app.
- Builds the upstream headers from scratch: every caller-sent `x-fingerly-*`
  header, `Cookie`, `Authorization` and forwarding header is dropped, and only
  the allowlisted client headers cross.
- Forwards the JA4 fingerprint Cloudflare computed for the visitor's TLS
  handshake as `x-fingerly-edge-ja4`, only when Cloudflare provides one
  (`request.cf.botManagement.ja4`, on zones with Bot Management) and it is
  shaped like JA4. No other detail of the TLS or HTTP connection is sent.
- Forwards nothing and answers 500 when `CF-Connecting-IP` does not hold one
  IPv4 or IPv6 address, logging it once per isolate.
- Reads request bodies with the 1 MiB cap as they arrive (413 over it).
- Reads the upstream answer in full, up to 4 MiB and under the one 5-second
  deadline, before relaying it. A timeout answers 504; an unreachable
  upstream, a broken answer or one over the cap answers 502. A visitor who
  disconnects cancels the upstream call.
- Answers an upstream redirect, or any status outside 200 to 599, with 502
  marked `no-store`, like the server SDK proxies. `Location` never crosses.
- Forwards to the one Fingerly API, relaying only `content-type`,
  `x-request-id`, the rate limit headers and `retry-after`.
- `FINGERLY_DEV_UPSTREAM` points the Worker at a loopback API for local
  testing; any other value is ignored.
- The README writes `.dev.vars` from a prompt (`read -rs`), readable only by
  you, so the key never appears on a command line or in the shell history.
