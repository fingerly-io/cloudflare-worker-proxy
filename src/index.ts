export interface Env {
  FINGERLY_PROXY_KEY: string
  FINGERLY_ROUTE_PREFIX: string
  FINGERLY_ALLOWED_ORIGINS?: string
  FINGERLY_INTEGRATION_ID?: string
}

const VERSION = '0.1.0'
const MAX_BODY_BYTES = 1_048_576
const UPSTREAM_TIMEOUT_MS = 5_000
const UPSTREAMS = { eu: 'https://eu.api.fingerly.io', us: 'https://us.api.fingerly.io' } as const
type Region = keyof typeof UPSTREAMS

function regionFromProxyKey(key: string): Region | null {
  const match = /^fly_px_(eu|us)_(?:production|staging|development)_/.exec(key)
  return match?.[1] === 'eu' || match?.[1] === 'us' ? match[1] : null
}

function routeTail(pathname: string, prefix: string): string | null {
  const base = prefix.trim().replace(/\/+$/, '')
  if (!base.startsWith('/') || base === '' || !pathname.startsWith(base + '/api/v1/')) return null
  const tail = pathname.slice(base.length)
  if (tail === '/api/v1/identify') return tail
  if (/^\/api\/v1\/events\/[A-Za-z0-9_-]{1,128}\/supplement$/.test(tail)) return tail
  return null
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return new URL(request.url).origin
  const allowed = new Set((env.FINGERLY_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean))
  return allowed.has(origin) ? origin : null
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({ 'cache-control': 'no-store' })
  if (origin) {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-methods', 'POST, OPTIONS')
    headers.set('access-control-allow-headers', 'content-type, x-api-key, idempotency-key')
    headers.set('access-control-expose-headers', 'x-request-id, ratelimit-limit, ratelimit-remaining, retry-after, fingerly-balance-micros')
    headers.set('access-control-max-age', '600')
    headers.set('vary', 'Origin')
  }
  return headers
}

function plain(status: number, message: string, origin: string | null = null): Response {
  return new Response(status === 204 ? null : message, { status, headers: corsHeaders(origin) })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request, env)
    if (!origin) return plain(403, 'Forbidden')
    if (request.method === 'OPTIONS') return plain(204, '', origin)
    if (request.method !== 'POST') return plain(405, 'Method Not Allowed', origin)
    const tail = routeTail(new URL(request.url).pathname, env.FINGERLY_ROUTE_PREFIX)
    if (!tail) return plain(404, 'Not Found', origin)

    const region = regionFromProxyKey(env.FINGERLY_PROXY_KEY)
    if (!region) return plain(503, 'Proxy configuration is invalid', origin)
    const publicKey = request.headers.get('x-api-key')
    if (!publicKey) return plain(401, 'Unauthorized', origin)
    const declaredLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return plain(413, 'Payload Too Large', origin)
    const body = await request.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES) return plain(413, 'Payload Too Large', origin)

    const headers = new Headers({
      'content-type': request.headers.get('content-type') ?? 'application/json',
      'x-api-key': publicKey,
      'x-fingerly-proxy-key': env.FINGERLY_PROXY_KEY,
      'x-fingerly-client-ip': request.headers.get('cf-connecting-ip') ?? '',
      'x-fingerly-origin': origin,
      'x-fingerly-user-agent': request.headers.get('user-agent') ?? '',
      'x-fingerly-proxy-version': VERSION,
    })
    const idempotency = request.headers.get('idempotency-key')
    if (idempotency) headers.set('idempotency-key', idempotency)
    if (env.FINGERLY_INTEGRATION_ID) headers.set('x-fingerly-proxy-integration-id', env.FINGERLY_INTEGRATION_ID)

    let upstream: Response
    try {
      upstream = await fetch(UPSTREAMS[region] + tail, {
        method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch {
      return plain(502, 'Bad Gateway', origin)
    }

    const outgoing = new Headers(upstream.headers)
    outgoing.delete('set-cookie')
    corsHeaders(origin).forEach((value, name) => outgoing.set(name, value))
    outgoing.set('x-fingerly-proxy-version', VERSION)
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outgoing })
  },
} satisfies ExportedHandler<Env>

export const testing = { regionFromProxyKey, routeTail }
