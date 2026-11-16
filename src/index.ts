export interface Env {
  /** The `fly_px_...` key the dashboard issued, set as a Worker secret. */
  FINGERLY_PROXY_KEY: string
  /** The path the dashboard issued, such as `/k7x2qm4a`. SDKs post here. */
  FINGERLY_PATH: string
  /**
   * Other origins whose pages may post here, comma-separated. Only needed when
   * the Worker answers on a different host from the page; a route on the
   * page's own host needs nothing.
   */
  FINGERLY_ALLOWED_ORIGINS?: string
  /**
   * Local testing only: an API on this machine, such as
   * `http://localhost:8080`, to forward to instead of Fingerly's. Anything
   * that is not a loopback origin is ignored, so a deployed Worker cannot be
   * pointed anywhere else.
   */
  FINGERLY_DEV_UPSTREAM?: string
}

const VERSION = '0.3.0'
const MAX_BODY_BYTES = 1_048_576
/** The most of an answer relayed: an answer is a few kilobytes. */
const MAX_RESPONSE_BYTES = 4 * 1_048_576
/** One deadline for the whole exchange: connect, send, headers and body. */
const UPSTREAM_TIMEOUT_MS = 5_000
/**
 * The one URL this Worker can reach. A constant rather than anything derived
 * from configuration: a misconfigured Worker must not be able to send a
 * customer's traffic somewhere else. Single-pass browser and native SDK
 * submissions post here as raw bytes.
 */
const UPSTREAM = 'https://api.fingerly.io/api/v1/ingest'
const INGEST_PATH = '/api/v1/ingest'

/** Exact lowercase platform names accepted on the native SDK channel. */
const SDK_PLATFORM_RE = /^(ios|android|react-native|react-native-ios|react-native-android|flutter|flutter-ios|flutter-android|lynx-ios|lynx-android|capacitor|kotlin-multiplatform)$/

/** Allowlisted client headers forwarded verbatim when present. */
const FORWARDED_CLIENT_HEADERS = [
  'idempotency-key',
  'user-agent',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
]

/**
 * The response headers relayed to the caller, and nothing else. A blocker can
 * match a response header by name, so an allowlist is what guarantees nothing
 * on the way back names Fingerly, whatever the API sends in future.
 */
const RELAYED_HEADERS = ['content-type', 'x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'retry-after']

/** Whether the configured value is shaped like a Fingerly proxy key. */
function isProxyKey(key: string): boolean {
  return /^fly_px_(?:production|staging|development)_[A-Za-z0-9_-]+$/.test(key)
}

/**
 * Whether the caller's X-Api-Key is a public key of the proxy key's
 * environment. Anything else, a secret `fly_sk_` key included, is answered 401
 * here rather than sent upstream.
 */
function isPublicKeyFor(proxyKey: string, publicKey: string | null): publicKey is string {
  const environment = /^fly_px_(production|staging|development)_/.exec(proxyKey)?.[1]
  return Boolean(environment) && new RegExp(`^fly_pk_${environment}_[A-Za-z0-9_-]+$`).test(publicKey ?? '')
}

/**
 * Whether the request is for the one configured path.
 *
 * Exactly that path: no trailing slash, nothing under it, case-sensitive. An
 * encoded slash stays encoded in the pathname, so it never matches either.
 */
function isProxyPath(pathname: string, configured: string): boolean {
  const path = configured.trim().replace(/\/+$/, '')
  return path.startsWith('/') && path.length > 1 && pathname === path
}

/** Captures incoming x-fingerly-sdk-platform only when it matches the exact lowercase allowlist. */
function validatedSdkPlatform(headers: Headers): string {
  const raw = headers.get('x-fingerly-sdk-platform') ?? ''
  return SDK_PLATFORM_RE.test(raw) ? raw : ''
}

/** Where to forward: the constant, or a loopback API while testing locally. */
function upstreamFor(env: Env): string {
  const dev = env.FINGERLY_DEV_UPSTREAM?.trim()
  if (!dev) return UPSTREAM
  try {
    const url = new URL(dev)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (loopback && (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname.replace(/\/+$/, '') === '') {
      return `${url.origin}${INGEST_PATH}`
    }
  } catch {
    // Not a URL; ignored like any other value that is not loopback.
  }
  return UPSTREAM
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** Whether the value is one IPv4 or IPv6 literal and nothing else. */
function isIpLiteral(value: string): boolean {
  if (IPV4.test(value)) return true
  if (!/^[0-9A-Fa-f:.]+$/.test(value) || !value.includes(':')) return false
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2
  } catch {
    return false
  }
}

/**
 * Checks incoming Origin when present. Never synthesizes an origin from the
 * Worker's own URL: requests without Origin must carry a validated
 * x-fingerly-sdk-platform header or are rejected with 400 missing_origin.
 */
function allowedOrigin(request: Request, env: Env): { origin: string; cross: boolean } | null {
  const own = new URL(request.url).origin
  const origin = request.headers.get('origin') ?? ''
  if (!origin) return { origin: '', cross: false }
  if (origin === own) return { origin, cross: false }
  const allowed = new Set((env.FINGERLY_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean))
  return allowed.has(origin) ? { origin, cross: true } : null
}

function baseHeaders(cors: string | null): Headers {
  const headers = new Headers({ 'cache-control': 'no-store' })
  if (cors) {
    headers.set('access-control-allow-origin', cors)
    headers.set('access-control-allow-methods', 'POST, OPTIONS')
    headers.set('access-control-allow-headers', 'content-type, x-api-key, idempotency-key, x-fingerly-sdk-platform')
    headers.set('access-control-expose-headers', 'x-request-id, ratelimit-limit, ratelimit-remaining, retry-after')
    headers.set('access-control-max-age', '600')
    headers.set('vary', 'Origin')
  }
  return headers
}

function plain(status: number, message: string, cors: string | null = null, extra: Record<string, string> = {}): Response {
  const headers = baseHeaders(cors)
  if (status !== 204) headers.set('content-type', 'text/plain; charset=utf-8')
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return new Response(status === 204 ? null : message, { status, headers })
}

function jsonError(status: number, code: string, message: string, cors: string | null = null): Response {
  const headers = baseHeaders(cors)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers })
}

/** Reported once per isolate rather than per request: it is configuration. */
let reportedMissingAddress = false

/** Reads a body to its end, or returns null once it passes `limit` bytes. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** One deadline, also ended when the visitor goes away. */
function deadline(visitor: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  const any = (AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return visitor && typeof any === 'function' ? any([timeout, visitor]) : timeout
}

interface CfMetadata {
  tlsVersion?: unknown
  tlsCipher?: unknown
  httpProtocol?: unknown
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!isProxyPath(url.pathname, env.FINGERLY_PATH)) return plain(404, 'Not Found')
    const page = allowedOrigin(request, env)
    if (!page) return plain(403, 'Forbidden')
    const cors = page.cross ? page.origin : null
    if (request.method === 'OPTIONS') return plain(204, '', cors, { allow: 'POST, OPTIONS' })
    if (request.method !== 'POST') return plain(405, 'Method Not Allowed', cors, { allow: 'POST' })

    if (!isProxyKey(env.FINGERLY_PROXY_KEY)) return plain(503, 'Service Unavailable', cors)

    // 1. Capture validated x-fingerly-sdk-platform.
    const sdkPlatform = validatedSdkPlatform(request.headers)
    // 2-4. Strip all incoming x-fingerly-* (and Cookie/Authorization) by building
    // outgoing headers from scratch below, restore validated x-fingerly-sdk-platform,
    // and reject with 400 missing_origin iff both Origin and sdkPlatform are empty.
    if (!page.origin && !sdkPlatform) {
      return jsonError(400, 'missing_origin', 'Origin or X-Fingerly-SDK-Platform header is required', cors)
    }

    const publicKey = request.headers.get('x-api-key')
    if (!isPublicKeyFor(env.FINGERLY_PROXY_KEY, publicKey)) return plain(401, 'Unauthorized', cors)

    const clientIp = request.headers.get('cf-connecting-ip')?.trim() ?? ''
    if (!isIpLiteral(clientIp)) {
      if (!reportedMissingAddress) {
        reportedMissingAddress = true
        console.error('proxy: CF-Connecting-IP held no valid client address; nothing was forwarded')
      }
      return plain(500, 'The client IP source returned no valid address', cors)
    }

    const declaredLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return plain(413, 'Payload Too Large', cors)
    const body = await readCapped(request.body, MAX_BODY_BYTES)
    if (body === null) return plain(413, 'Payload Too Large', cors)

    const headers = new Headers({
      'content-type': request.headers.get('content-type') ?? 'application/json',
      'x-api-key': publicKey,
      'x-fingerly-proxy-key': env.FINGERLY_PROXY_KEY,
      'x-fingerly-client-ip': clientIp,
      'x-fingerly-user-agent': request.headers.get('user-agent') ?? '',
      'x-fingerly-proxy-version': `cloudflare-worker/${VERSION}`,
    })
    if (page.origin) headers.set('x-fingerly-origin', page.origin)
    if (sdkPlatform) headers.set('x-fingerly-sdk-platform', sdkPlatform)
    const host = request.headers.get('host') || url.host
    if (host) headers.set('x-fingerly-host', host)
    for (const name of FORWARDED_CLIENT_HEADERS) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }

    const cf = (request as Request & { cf?: CfMetadata }).cf
    if (typeof cf?.tlsVersion === 'string' && cf.tlsVersion !== '') {
      headers.set('x-fingerly-edge-tls-version', cf.tlsVersion)
    }
    if (typeof cf?.tlsCipher === 'string' && cf.tlsCipher !== '') {
      headers.set('x-fingerly-edge-tls-cipher', cf.tlsCipher)
    }
    if (typeof cf?.httpProtocol === 'string' && cf.httpProtocol !== '') {
      headers.set('x-fingerly-edge-http-proto', cf.httpProtocol)
    }

    const signal = deadline(request.signal)
    let upstream: Response
    let answer: Uint8Array | null
    try {
      upstream = await fetch(upstreamFor(env), { method: 'POST', headers, body, redirect: 'manual', signal })
      // Read whole, under the same deadline, before anything is sent back: a
      // truncated answer relayed with a 200 would be read as a success.
      answer = await readCapped(upstream.body, MAX_RESPONSE_BYTES)
    } catch (error) {
      if (request.signal?.aborted) return plain(499, '', cors)
      const timedOut = (error as { name?: string } | null)?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError'
      console.warn(timedOut ? 'proxy: upstream timed out' : 'proxy: upstream unreachable')
      return timedOut ? plain(504, 'Gateway timeout', cors) : plain(502, 'Bad gateway', cors)
    }
    if (answer === null) {
      console.warn('proxy: upstream answer over the size limit')
      return plain(502, 'Bad gateway', cors)
    }

    const outgoing = baseHeaders(cors)
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) outgoing.set(name, value)
    }
    const bodiless = [101, 204, 205, 304].includes(upstream.status)
    return new Response(bodiless ? null : answer, { status: upstream.status, statusText: upstream.statusText, headers: outgoing })
  },
} satisfies ExportedHandler<Env>

export const testing = { isProxyKey, isPublicKeyFor, isProxyPath, isIpLiteral, validatedSdkPlatform, upstreamFor, UPSTREAM }
