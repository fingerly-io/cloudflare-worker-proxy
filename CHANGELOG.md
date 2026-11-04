# Changelog

## 0.2.0 (unreleased)

- Answers exactly the issued path: no trailing slash, case-sensitive. A 405
  carries `Allow: POST`, and every refusal is plain text.
- Forwards nothing and answers 500 when `CF-Connecting-IP` does not hold one
  IPv4 or IPv6 address, logging it once per isolate.
- Reads the upstream answer in full, up to 4 MiB and under the one 5-second
  deadline, before relaying it. A timeout answers 504; an unreachable
  upstream, a broken answer or one over the cap answers 502. A visitor who
  disconnects cancels the upstream call.
- Reads request bodies with the 1 MiB cap as they arrive.
- `FINGERLY_DEV_UPSTREAM` points the Worker at a loopback API for local
  testing; any other value is ignored.
- Forwards to the one Fingerly API, relaying only `content-type`,
  `x-request-id`, the rate limit headers and `retry-after`.
