import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { testing, type Env } from '../src/index.js'

const env: Env = {
  FINGERLY_PROXY_KEY: 'fly_px_production_proxy', FINGERLY_PATH: '/k7x2qm4a',
  FINGERLY_ALLOWED_ORIGINS: 'https://www.shop.example',
}

function post(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: 'POST', headers: { 'x-api-key': 'fly_pk_production_public', ...headers }, body: '{}' })
}

afterEach(() => vi.unstubAllGlobals())

describe('routing', () => {
  it('serves only a well-formed proxy key', () => {
    expect(testing.isProxyKey('fly_px_production_x')).toBe(true)
    expect(testing.isProxyKey('fly_px_staging_x')).toBe(true)
    expect(testing.isProxyKey('fly_pk_production_x')).toBe(false)
    expect(testing.isProxyKey('fly_px_sandbox_x')).toBe(false)
    expect(testing.isProxyKey('')).toBe(false)
  })

  it('answers the one configured path and nothing under or beside it', () => {
    expect(testing.isProxyPath('/k7x2qm4a', '/k7x2qm4a')).toBe(true)
    expect(testing.isProxyPath('/k7x2qm4a', '/k7x2qm4a/')).toBe(true)
    expect(testing.isProxyPath('/k7x2qm4a/', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a//', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/K7X2QM4A', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a%2F', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a/api/v1/identify', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4ab', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/', '/')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a', '')).toBe(false)
  })
})

describe('client address', () => {
  it('accepts one IPv4 or IPv6 literal and nothing else', () => {
    for (const ok of ['203.0.113.9', '::1', '2001:db8::1', '::ffff:192.0.2.1']) expect(testing.isIpLiteral(ok), ok).toBe(true)
    for (const bad of ['', 'null', 'undefined', '203.0.113.9, 10.0.0.1', '256.1.1.1', 'example.com', '[::1]', '1.2.3']) {
      expect(testing.isIpLiteral(bad), bad).toBe(false)
    }
  })

  it('forwards nothing and answers 500 when CF-Connecting-IP is missing or malformed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const value of [undefined, 'null', '1.2.3.4, 5.6.7.8']) {
      const result = await worker.fetch(post('https://shop.example/k7x2qm4a', value === undefined ? {} : { 'cf-connecting-ip': value }), env)
      expect(result.status).toBe(500)
      expect(result.headers.get('content-type')).toContain('text/plain')
      expect(await result.text()).toMatch(/no valid address/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logged.mock.calls.length).toBeLessThanOrEqual(1)
    logged.mockRestore()
  })
})

describe('worker boundary', () => {
  it('refuses unapproved origins and other paths', async () => {
    expect((await worker.fetch(post('https://shop.example/k7x2qm4a', { origin: 'https://evil.example' }), env)).status).toBe(403)
    expect((await worker.fetch(post('https://shop.example/admin', { origin: 'https://shop.example' }), env)).status).toBe(404)
  })

  it('answers a listed cross-origin preflight, and adds no CORS on its own host', async () => {
    const preflight = await worker.fetch(new Request('https://edge.shop.example/k7x2qm4a', {
      method: 'OPTIONS', headers: { origin: 'https://www.shop.example' },
    }), env)
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://www.shop.example')
    expect(preflight.headers.get('access-control-expose-headers')).not.toContain('fingerly')

    const sameHost = await worker.fetch(new Request('https://shop.example/k7x2qm4a', {
      method: 'OPTIONS', headers: { origin: 'https://shop.example' },
    }), env)
    expect(sameHost.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('forwards to the one upstream with the visitor metadata and relays nothing that names us', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"request_id":"r"}', {
      status: 200,
      headers: {
        'content-type': 'application/json', 'x-request-id': 'r', 'ratelimit-remaining': '9',
        'fingerly-balance-micros': '100', 'x-fingerly-proxy-version': 'api', 'set-cookie': 'a=b', server: 'fingerly-api',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', {
      origin: 'https://shop.example', 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0',
      'idempotency-key': 'op-1', cookie: 'session=1', authorization: 'Bearer x',
    }), env)

    expect(result.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.fingerly.io/api/v1/ingest')
    const sent = new Headers(init?.headers)
    expect(sent.get('x-fingerly-proxy-key')).toBe('fly_px_production_proxy')
    expect(sent.get('x-fingerly-client-ip')).toBe('203.0.113.9')
    expect(sent.get('x-fingerly-origin')).toBe('https://shop.example')
    expect(sent.get('x-fingerly-proxy-version')).toBe('cloudflare-worker/0.2.0')
    expect(sent.get('idempotency-key')).toBe('op-1')
    expect(sent.get('cookie')).toBeNull()
    expect(sent.get('authorization')).toBeNull()

    const relayed = [...result.headers].map(([name, value]) => `${name}: ${value}`).join('\n')
    expect(relayed).not.toMatch(/fingerly|set-cookie/i)
    expect(result.headers.get('x-request-id')).toBe('r')
    expect(result.headers.get('ratelimit-remaining')).toBe('9')
  })

  it('answers 405 with Allow: POST for every other method', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const result = await worker.fetch(new Request('https://shop.example/k7x2qm4a', { method }), env)
      expect(result.status).toBe(405)
      expect(result.headers.get('allow')).toBe('POST')
      expect(result.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('refuses rather than forwards when the key is not a proxy key', async () => {
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a'), { ...env, FINGERLY_PROXY_KEY: 'fly_sk_production_x' })
    expect(result.status).toBe(503)
  })
})

describe('upstream trouble', () => {
  const visitor = { origin: 'https://shop.example', 'cf-connecting-ip': '203.0.113.9' }

  it('answers 504 when the upstream does not answer in time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(504)
    expect(await result.text()).toBe('Gateway timeout')
    expect(result.headers.get('cache-control')).toBe('no-store')
  })

  it('answers 502 when the upstream is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Network connection lost.')
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(502)
    expect(await result.text()).toBe('Bad gateway')
  })

  it('answers 502, not a truncated 200, when the answer breaks off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"request_id":'))
        controller.error(new TypeError('Network connection lost.'))
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(502)
  })

  it('answers 502 for an answer over 4 MiB', async () => {
    const big = new Uint8Array(4 * 1_048_576 + 1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big, { status: 200 })))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(502)
  })

  it('refuses a body over 1 MiB that declares no length', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577))
        controller.close()
      },
    })
    const request = new Request('https://shop.example/k7x2qm4a', {
      method: 'POST', body: stream, headers: { 'x-api-key': 'fly_pk_production_public', ...visitor }, duplex: 'half',
    } as RequestInit)
    const result = await worker.fetch(request, env)
    expect(result.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

