export interface Env {
  /** The `fly_px_...` key the dashboard issued, set as a Worker secret. */
  FINGERLY_PROXY_KEY: string
  /** The path the dashboard issued, such as `/k7x2qm4a`. The browser SDK posts here. */
  FINGERLY_PATH: string
  /**
   * Other origins whose pages may post here, comma-separated. Only needed when
   * the Worker answers on a different host from the page; a route on the
   * page's own host needs nothing.
   */
  FINGERLY_ALLOWED_ORIGINS?: string
}

const VERSION = '0.2.0'
const MAX_BODY_BYTES = 1_048_576
const UPSTREAM_TIMEOUT_MS = 5_000
/**
 * The one URL this Worker can reach. A constant rather than anything derived
 * from configuration: a misconfigured Worker must not be able to send a
 * customer's traffic somewhere else. Both of the browser SDK's calls go here;
 * the API tells them apart by their bodies.
 */
const UPSTREAM = 'https://api.fingerly.io/api/v1/ingest'

/**
 * The response headers relayed to the page, and nothing else. A blocker can
 * match a response header by name, so an allowlist is what guarantees nothing
 * on the way back names Fingerly, whatever the API sends in future.
 */
const RELAYED_HEADERS = ['content-type', 'x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'retry-after']

/** Whether the configured value is shaped like a Fingerly proxy key. */
function isProxyKey(key: string): boolean {
  return /^fly_px_(?:production|staging|development)_[A-Za-z0-9_-]+$/.test(key)
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

/**
 * The page origin, when it may use this Worker. A request from the Worker's
 * own host always may; another origin only when it is listed.
 */
function allowedOrigin(request: Request, env: Env): { origin: string; cross: boolean } | null {
  const own = new URL(request.url).origin
  const origin = request.headers.get('origin')
  if (!origin || origin === own) return { origin: own, cross: false }
  const allowed = new Set((env.FINGERLY_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean))
  return allowed.has(origin) ? { origin, cross: true } : null
}

function baseHeaders(cors: string | null): Headers {
  const headers = new Headers({ 'cache-control': 'no-store' })
  if (cors) {
    headers.set('access-control-allow-origin', cors)
    headers.set('access-control-allow-methods', 'POST, OPTIONS')
    headers.set('access-control-allow-headers', 'content-type, x-api-key, idempotency-key')
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isProxyPath(new URL(request.url).pathname, env.FINGERLY_PATH)) return plain(404, 'Not Found')
    const page = allowedOrigin(request, env)
    if (!page) return plain(403, 'Forbidden')
    const cors = page.cross ? page.origin : null
    if (request.method === 'OPTIONS') return plain(204, '', cors, { allow: 'POST, OPTIONS' })
    if (request.method !== 'POST') return plain(405, 'Method Not Allowed', cors, { allow: 'POST' })

    if (!isProxyKey(env.FINGERLY_PROXY_KEY)) return plain(503, 'Service Unavailable', cors)
    const publicKey = request.headers.get('x-api-key')
    if (!publicKey) return plain(401, 'Unauthorized', cors)
    const declaredLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return plain(413, 'Payload Too Large', cors)
    const body = await request.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES) return plain(413, 'Payload Too Large', cors)

    const headers = new Headers({
      'content-type': request.headers.get('content-type') ?? 'application/json',
      'x-api-key': publicKey,
      'x-fingerly-proxy-key': env.FINGERLY_PROXY_KEY,
      'x-fingerly-client-ip': request.headers.get('cf-connecting-ip') ?? '',
      'x-fingerly-origin': page.origin,
      'x-fingerly-user-agent': request.headers.get('user-agent') ?? '',
      'x-fingerly-proxy-version': `cloudflare-worker/${VERSION}`,
    })
    const idempotency = request.headers.get('idempotency-key')
    if (idempotency) headers.set('idempotency-key', idempotency)

    let upstream: Response
    try {
      upstream = await fetch(UPSTREAM, {
        method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch {
      return plain(502, 'Bad Gateway', cors)
    }

    const outgoing = baseHeaders(cors)
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) outgoing.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outgoing })
  },
} satisfies ExportedHandler<Env>

export const testing = { isProxyKey, isProxyPath, UPSTREAM }
