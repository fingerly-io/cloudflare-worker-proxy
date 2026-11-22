import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { testing, type Env } from '../src/index.js'

const env: Env = {
  FINGERLY_PROXY_KEY: 'fly_px_production_proxy', FINGERLY_PATH: '/k7x2qm4a',
  FINGERLY_ALLOWED_ORIGINS: 'https://www.shop.example',
}

function post(url: string, headers: Record<string, string> = {}, body = '{}', cf?: Record<string, unknown>): Request {
  const req = new Request(url, { method: 'POST', headers: { 'x-api-key': 'fly_pk_production_public', ...headers }, body })
  if (cf) Object.defineProperty(req, 'cf', { value: cf, configurable: true })
  return req
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

  it('answers the one configured path and nothing under or beside it, retiring /supplement', () => {
    expect(testing.isProxyPath('/k7x2qm4a', '/k7x2qm4a')).toBe(true)
    expect(testing.isProxyPath('/k7x2qm4a', '/k7x2qm4a/')).toBe(true)
    expect(testing.isProxyPath('/k7x2qm4a/', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a//', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/K7X2QM4A', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a%2F', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a/api/v1/identify', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a/supplement', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a/events/evt_1/supplement', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4ab', '/k7x2qm4a')).toBe(false)
    expect(testing.isProxyPath('/', '/')).toBe(false)
    expect(testing.isProxyPath('/k7x2qm4a', '')).toBe(false)
  })

  it('returns 404 with no-store on retired supplement subpaths', async () => {
    for (const suffix of ['/supplement', '/events/evt_123/supplement', '/api/v1/ingest/supplement']) {
      const result = await worker.fetch(post(`https://shop.example/k7x2qm4a${suffix}`, {
        origin: 'https://shop.example', 'cf-connecting-ip': '203.0.113.9',
      }), env)
      expect(result.status, suffix).toBe(404)
      expect(result.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('client address', () => {
  it('accepts one IPv4 or IPv6 literal and nothing else', () => {
    for (const ok of ['203.0.113.9', '::1', '2001:db8::1', '::ffff:192.0.2.1']) expect(testing.isIpLiteral(ok), ok).toBe(true)
    for (const bad of ['', 'null', 'undefined', '203.0.113.9, 10.0.0.1', '256.1.1.1', 'example.com', '[::1]', '1.2.3', 'fe80::1%en0']) {
      expect(testing.isIpLiteral(bad), bad).toBe(false)
    }
  })

  it('forwards nothing and answers 500 when CF-Connecting-IP is missing or malformed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const value of [undefined, 'null', '1.2.3.4, 5.6.7.8']) {
      const result = await worker.fetch(post('https://shop.example/k7x2qm4a', {
        origin: 'https://shop.example',
        ...(value === undefined ? {} : { 'cf-connecting-ip': value }),
      }), env)
      expect(result.status).toBe(500)
      expect(result.headers.get('content-type')).toContain('text/plain')
      expect(await result.text()).toMatch(/no valid address/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logged.mock.calls.length).toBeLessThanOrEqual(1)
    logged.mockRestore()
  })
})

describe('sanitize-and-restore & origin gate', () => {
  it('validates exact lowercase native SDK platform values only', () => {
    const valid = [
      'ios', 'android', 'react-native', 'react-native-ios', 'react-native-android',
      'flutter', 'flutter-ios', 'flutter-android', 'lynx-ios', 'lynx-android',
      'capacitor', 'kotlin-multiplatform',
    ]
    for (const platform of valid) {
      expect(testing.validatedSdkPlatform(new Headers({ 'x-fingerly-sdk-platform': platform })), platform).toBe(platform)
    }
    for (const bad of ['', 'iOS', 'IOS', 'Android', 'EvilOS', 'web', 'ios, android', 'ios, ios', 'react_native']) {
      expect(testing.validatedSdkPlatform(new Headers({ 'x-fingerly-sdk-platform': bad })), bad).toBe('')
    }
  })

  it('rejects originless POST without valid x-fingerly-sdk-platform with 400 missing_origin and never synthesizes x-fingerly-origin', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const originless = await worker.fetch(post('https://shop.example/k7x2qm4a', {
      'cf-connecting-ip': '203.0.113.9',
      referer: 'https://shop.example/checkout',
    }), env)
    expect(originless.status).toBe(400)
    expect(originless.headers.get('cache-control')).toBe('no-store')
    expect(await originless.json()).toEqual({
      error: { code: 'missing_origin', message: 'Origin or X-Fingerly-SDK-Platform header is required' },
    })

    // Spoofed x-fingerly-* headers and invalid x-fingerly-sdk-platform are stripped and rejected with 400 when Origin is absent.
    for (const spoofed of ['EvilOS', 'iOS', 'IOS', 'web', 'ios, EvilOS']) {
      const res = await worker.fetch(post('https://shop.example/k7x2qm4a', {
        'cf-connecting-ip': '203.0.113.9',
        'x-fingerly-sdk-platform': spoofed,
        'x-fingerly-origin': 'https://shop.example',
        'x-fingerly-client-ip': '1.2.3.4',
        'x-fingerly-edge-tls-version': 'TLSv1.0',
      }), env)
      expect(res.status, spoofed).toBe(400)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect((await res.json() as { error: { code: string } }).error.code).toBe('missing_origin')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards valid native POST without Origin, restoring x-fingerly-sdk-platform and omitting x-fingerly-origin', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"request_id":"r_native"}', {
      status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'r_native' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    for (const platform of ['ios', 'android', 'react-native-ios']) {
      fetchMock.mockClear()
      const rawBody = '{"v":3,"signals":{"metrics":{"dpr":142.50,"scale":3.00}}}'
      const result = await worker.fetch(post('https://shop.example/k7x2qm4a', {
        'cf-connecting-ip': '203.0.113.9',
        'x-fingerly-sdk-platform': platform,
        'x-fingerly-origin': 'https://spoofed.example',
        'x-fingerly-client-ip': '6.6.6.6',
        'x-fingerly-edge-tls-version': 'TLSv1.0',
        'idempotency-key': 'idem-native-1',
        'user-agent': 'FingerlySDK/0.3.0',
      }, rawBody), env)

      expect(result.status, platform).toBe(200)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://api.fingerly.io/api/v1/ingest')
      expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(rawBody)
      const sent = new Headers(init?.headers)
      expect(sent.get('x-fingerly-sdk-platform')).toBe(platform)
      expect(sent.get('x-fingerly-origin')).toBeNull()
      expect(sent.get('x-fingerly-client-ip')).toBe('203.0.113.9')
      expect(sent.get('x-fingerly-edge-tls-version')).toBeNull()
      expect(sent.get('idempotency-key')).toBe('idem-native-1')
    }
  })

  it('sends one channel header: a valid platform beside Origin is dropped and only x-fingerly-origin goes upstream', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    for (const platform of ['ios', 'android', 'react-native-ios']) {
      fetchMock.mockClear()
      const result = await worker.fetch(post('https://shop.example/k7x2qm4a', {
        origin: 'https://shop.example',
        'cf-connecting-ip': '203.0.113.9',
        'x-fingerly-sdk-platform': platform,
      }), env)

      expect(result.status, platform).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const sent = new Headers(fetchMock.mock.calls[0]![1]?.headers)
      expect(sent.get('x-fingerly-origin'), platform).toBe('https://shop.example')
      expect(sent.get('x-fingerly-sdk-platform'), platform).toBeNull()
    }
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
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-fingerly-sdk-platform')
    expect(preflight.headers.get('access-control-expose-headers')).toContain('retry-after')
    expect(preflight.headers.get('access-control-expose-headers')).not.toContain('fingerly')

    const sameHost = await worker.fetch(new Request('https://shop.example/k7x2qm4a', {
      method: 'OPTIONS', headers: { origin: 'https://shop.example' },
    }), env)
    expect(sameHost.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('forwards visitor metadata, Sec-Fetch-*, Sec-CH-UA*, raw body bytes, and Retry-After while stripping spoofed headers and adding no edge TLS headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"error":{"code":"request_in_progress"}}', {
      status: 409,
      headers: {
        'content-type': 'application/json', 'x-request-id': 'r', 'ratelimit-limit': '100', 'ratelimit-remaining': '9',
        'retry-after': '1', 'fingerly-balance-micros': '100', 'fingerly-ratelimit-scope': 'org',
        'x-fingerly-proxy-version': 'api', 'set-cookie': 'a=b', server: 'fingerly-api',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const rawBody = '{ "v": 3, "signals": { "price": 142.50, "nested": [1.00, 2.50] } }'
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', {
      origin: 'https://shop.example',
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'Mozilla/5.0',
      'idempotency-key': 'op-1',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-ch-ua': '"Chromium";v="130"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      cookie: 'session=1',
      authorization: 'Bearer x',
      'x-fingerly-origin': 'https://forged.example',
      'x-fingerly-client-ip': '6.6.6.6',
      'x-fingerly-edge-tls-version': 'TLSv1.0',
      'x-fingerly-sdk-platform': 'EvilOS',
    }, rawBody, {
      tlsVersion: 'TLSv1.3',
      tlsCipher: 'AEAD-AES128-GCM-SHA256',
      httpProtocol: 'HTTP/3',
    }), env)

    expect(result.status).toBe(409)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.fingerly.io/api/v1/ingest')
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(rawBody)
    const sent = new Headers(init?.headers)
    expect(sent.get('x-fingerly-proxy-key')).toBe('fly_px_production_proxy')
    expect(sent.get('x-fingerly-client-ip')).toBe('203.0.113.9')
    expect(sent.get('x-fingerly-origin')).toBe('https://shop.example')
    expect(sent.get('x-fingerly-host')).toBe('shop.example')
    expect(sent.get('x-fingerly-proxy-version')).toBe('cloudflare-worker/0.3.0')
    expect(sent.get('x-fingerly-sdk-platform')).toBeNull()
    expect(sent.get('idempotency-key')).toBe('op-1')
    expect(sent.get('sec-fetch-site')).toBe('same-origin')
    expect(sent.get('sec-fetch-mode')).toBe('cors')
    expect(sent.get('sec-fetch-dest')).toBe('empty')
    expect(sent.get('sec-ch-ua')).toBe('"Chromium";v="130"')
    expect(sent.get('sec-ch-ua-mobile')).toBe('?0')
    expect(sent.get('sec-ch-ua-platform')).toBe('"macOS"')
    // request.cf carries TLS details, and none of them is forwarded.
    expect(sent.get('x-fingerly-edge-tls-version')).toBeNull()
    expect(sent.get('x-fingerly-edge-tls-cipher')).toBeNull()
    expect(sent.get('x-fingerly-edge-http-proto')).toBeNull()
    expect([...sent.keys()].filter((name) => name.startsWith('x-fingerly-edge-'))).toEqual([])
    expect(sent.get('cookie')).toBeNull()
    expect(sent.get('authorization')).toBeNull()

    const relayed = [...result.headers].map(([name, value]) => `${name}: ${value}`).join('\n')
    expect(relayed).not.toMatch(/fingerly|set-cookie/i)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('x-request-id')).toBe('r')
    expect(result.headers.get('ratelimit-limit')).toBe('100')
    expect(result.headers.get('ratelimit-remaining')).toBe('9')
    expect(result.headers.get('retry-after')).toBe('1')
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

/** A browser visitor's headers, for the allowlist and public key checks. */
const browserVisitor = {
  origin: 'https://shop.example', 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0',
  'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
}

/** The Web Bot Auth headers an AI agent's browser adds to its requests. */
const signed = {
  signature: 'sig1=:dGVzdC1zaWduYXR1cmU=:',
  'signature-input': 'sig1=("@authority" "signature-agent");created=1735689600;keyid="k1";alg="ed25519";tag="web-bot-auth"',
  'signature-agent': '"https://chatgpt.com"',
}

/** An upstream that answers with relayed, internal and unknown headers. */
function stubUpstream() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"request_id":"r"}', {
    status: 200,
    headers: {
      'content-type': 'application/json', 'x-request-id': 'r', 'ratelimit-limit': '100', 'ratelimit-remaining': '9',
      'retry-after': '1', 'fingerly-balance-micros': '100', 'set-cookie': 'a=b', server: 'fingerly-api',
      'x-new-internal': '1', 'x-powered-by': 'api-stack', via: '1.1 api-internal',
    },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('header allowlists', () => {
  /** Names the contract (sdks/contract/proxy.md section 3) lets a proxy send upstream. */
  const CONTRACT_REQUEST = /^(x-api-key|content-type|idempotency-key|user-agent|sec-fetch-(site|mode|dest)|sec-ch-ua(-mobile|-platform)?|signature(-input|-agent)?|x-fingerly-[a-z-]+)$/
  const RELAYED_RESPONSE = /^(x-request-id|ratelimit-limit|ratelimit-remaining|retry-after|content-type|cache-control)$/

  it('forwards only the contract request headers and relays only the allowlisted response headers', async () => {
    const fetchMock = stubUpstream()
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', {
      ...browserVisitor,
      ...signed,
      referer: 'https://shop.example/reset?token=secret-token',
      'x-custom-token': 'app-header',
      forwarded: 'for=203.0.113.9',
      'x-forwarded-for': '6.6.6.6',
      'x-forwarded-host': 'forged.example',
      'x-real-ip': '6.6.6.6',
      'accept-language': 'tr-TR',
      cookie: 'session=1',
      authorization: 'Bearer secret',
    }), env)
    expect(result.status).toBe(200)
    const sent = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect([...sent.keys()].filter((name) => !CONTRACT_REQUEST.test(name))).toEqual([])
    expect(sent.get('x-fingerly-client-ip')).toBe('203.0.113.9')
    expect(sent.get('sec-fetch-site')).toBe('same-origin')
    expect(sent.get('sec-fetch-mode')).toBe('cors')
    expect(sent.get('sec-fetch-dest')).toBe('empty')
    expect(sent.get('x-custom-token')).toBeNull()
    expect(sent.get('signature')).toBe(signed.signature)
    expect(sent.get('signature-input')).toBe(signed['signature-input'])
    expect(sent.get('signature-agent')).toBe(signed['signature-agent'])
    expect(sent.get('x-fingerly-host')).toBe('shop.example')
    expect([...result.headers.keys()].filter((name) => !RELAYED_RESPONSE.test(name))).toEqual([])
  })

  it('drops a Web Bot Auth header over 4096 bytes and still forwards the request', async () => {
    const fetchMock = stubUpstream()
    const atCap = `"https://${'a'.repeat(4096 - 10)}"`
    expect(atCap).toHaveLength(4096)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', {
      ...browserVisitor,
      ...signed,
      signature: `sig1=:${'A'.repeat(4097)}:`,
      'signature-agent': atCap,
    }), env)
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect(sent.get('signature')).toBeNull()
    expect(sent.get('signature-input')).toBe(signed['signature-input'])
    expect(sent.get('signature-agent')).toBe(atCap)
    expect(result.headers.get('x-request-id')).toBe('r')
    expect(result.headers.get('cache-control')).toBe('no-store')
  })

  it('counts a Web Bot Auth header in the UTF-8 bytes the runtime sends, not in characters', async () => {
    const fetchMock = stubUpstream()
    // workerd reads header bytes as UTF-8, so 4098 bytes on the wire arrive as
    // 1366 characters; Node's Headers cannot hold such a value, so it is read here.
    const wide = '€'.repeat(1366)
    expect(new TextEncoder().encode(wide).byteLength).toBe(4098)
    const request = post('https://shop.example/k7x2qm4a', { ...browserVisitor, ...signed })
    const read = request.headers.get.bind(request.headers)
    Object.defineProperty(request, 'headers', {
      value: { get: (name: string) => (name.toLowerCase() === 'signature' ? wide : read(name)) },
    })
    const result = await worker.fetch(request, env)
    expect(result.status).toBe(200)
    const sent = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect(sent.get('signature')).toBeNull()
    expect(sent.get('signature-input')).toBe(signed['signature-input'])
  })

  it('keeps the signature headers out of the CORS allow list', async () => {
    const result = await worker.fetch(new Request('https://shop.example/k7x2qm4a', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    }), { ...env, FINGERLY_ALLOWED_ORIGINS: 'https://app.example' })
    expect(result.status).toBe(204)
    expect(result.headers.get('access-control-allow-headers')).toBe('content-type, x-api-key, idempotency-key, x-fingerly-sdk-platform')
  })
})

describe('edge JA4', () => {
  const JA4 = 't13d1516h2_8daaf6152771_b186095e22b6'
  async function sentFor(headers: Record<string, string>, cf?: Record<string, unknown>): Promise<Headers> {
    const fetchMock = stubUpstream()
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', { ...browserVisitor, ...headers }, '{}', cf), env)
    expect(result.status).toBe(200)
    return new Headers(fetchMock.mock.calls[0]![1]?.headers)
  }

  it('forwards the JA4 Cloudflare computed when Bot Management provides it', async () => {
    const sent = await sentFor({}, { botManagement: { score: 90, ja4: JA4 } })
    expect(sent.get('x-fingerly-edge-ja4')).toBe(JA4)
  })

  it('sends no JA4 header when Cloudflare provides none', async () => {
    for (const cf of [undefined, {}, { botManagement: null }, { botManagement: { score: 90 } }]) {
      const sent = await sentFor({}, cf)
      expect(sent.get('x-fingerly-edge-ja4')).toBeNull()
    }
  })

  it('strips a client-sent copy, with or without an edge value', async () => {
    const forged = 't13d0000h2_000000000000_000000000000'
    expect((await sentFor({ 'x-fingerly-edge-ja4': forged })).get('x-fingerly-edge-ja4')).toBeNull()
    expect((await sentFor({ 'x-fingerly-edge-ja4': forged }, { botManagement: { ja4: JA4 } })).get('x-fingerly-edge-ja4')).toBe(JA4)
  })

  it('does not forward a malformed edge value', async () => {
    for (const ja4 of ['', 'garbage', `${JA4}\r\nx-evil: 1`, JA4.toUpperCase(), `${JA4}_extra`, 42, { a: 1 }]) {
      const sent = await sentFor({}, { botManagement: { ja4 } })
      expect(sent.get('x-fingerly-edge-ja4'), String(ja4)).toBeNull()
    }
  })
})

describe('local public key check', () => {
  it('answers 401 before any upstream call for an X-Api-Key that is not a public key of the proxy key environment', async () => {
    for (const key of ['fly_pk_development_x', 'fly_pk_staging_x', 'not-a-key', 'fly_sk_production_x', 'fly_pk_production_', 'fly_px_production_x', undefined]) {
      const fetchMock = stubUpstream()
      const headers: Record<string, string> = { ...browserVisitor }
      const request = new Request('https://shop.example/k7x2qm4a', { method: 'POST', headers: key === undefined ? headers : { ...headers, 'x-api-key': key }, body: '{}' })
      const result = await worker.fetch(request, env)
      expect(result.status, String(key)).toBe(401)
      expect(result.headers.get('cache-control'), String(key)).toBe('no-store')
      expect(fetchMock, String(key)).not.toHaveBeenCalled()
    }
    // The environment comes from the proxy key itself.
    const fetchMock = stubUpstream()
    const staging = await worker.fetch(post('https://shop.example/k7x2qm4a', { ...browserVisitor, 'x-api-key': 'fly_pk_staging_public' }), { ...env, FINGERLY_PROXY_KEY: 'fly_px_staging_proxy' })
    expect(staging.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('matches the public key to the proxy key environment', () => {
    expect(testing.isPublicKeyFor('fly_px_production_a', 'fly_pk_production_b-C_9')).toBe(true)
    expect(testing.isPublicKeyFor('fly_px_development_a', 'fly_pk_production_b')).toBe(false)
    expect(testing.isPublicKeyFor('fly_px_production_a', 'fly_sk_production_b')).toBe(false)
    expect(testing.isPublicKeyFor('fly_px_production_a', null)).toBe(false)
    expect(testing.isPublicKeyFor('', 'fly_pk_production_b')).toBe(false)
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

  it.each([301, 302, 303, 304, 307, 308, 399])('answers %i from upstream with 502 and no Location', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status,
      headers: { location: 'https://elsewhere.example/steal', 'x-request-id': 'r_redirect' },
    })))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(502)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('location')).toBeNull()
    expect(result.headers.get('x-request-id')).toBeNull()
    expect(await result.text()).toBe('Bad gateway')
  })

  it.each([0, 101, 199, 600, 999])('answers status %i from upstream with 502', async (status) => {
    // Runtimes refuse to build a Response with these statuses, so the answer is faked.
    const fake = { status, statusText: '', redirected: false, headers: new Headers(), body: null } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => fake))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(502)
    expect(result.headers.get('cache-control')).toBe('no-store')
  })

  it('answers an opaque redirect with 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.error()))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(502)
  })

  it.each([200, 204, 400, 409, 429, 500, 503, 599])('relays status %i from upstream', async (status) => {
    const empty = status === 204
    vi.stubGlobal('fetch', vi.fn(async () => new Response(empty ? null : '{}', {
      status, headers: { location: 'https://elsewhere.example/' },
    })))
    const result = await worker.fetch(post('https://shop.example/k7x2qm4a', visitor), env)
    expect(result.status).toBe(status)
    expect(result.headers.get('location')).toBeNull()
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

describe('local testing upstream', () => {
  it('forwards to a loopback API only, and to Fingerly for anything else', () => {
    const at = (value?: string) => testing.upstreamFor({ ...env, ...(value === undefined ? {} : { FINGERLY_DEV_UPSTREAM: value }) })
    expect(at()).toBe(testing.UPSTREAM)
    expect(at('http://localhost:8080')).toBe('http://localhost:8080/api/v1/ingest')
    expect(at('http://127.0.0.1:9003/')).toBe('http://127.0.0.1:9003/api/v1/ingest')
    expect(at('http://[::1]:9003')).toBe('http://[::1]:9003/api/v1/ingest')
    for (const other of ['https://evil.example', 'http://localhost.evil.example', 'http://10.0.0.1', 'http://localhost:8080/elsewhere', 'file:///etc/passwd', 'nonsense']) {
      expect(at(other), other).toBe(testing.UPSTREAM)
    }
  })

  it('sends the request to the loopback API it names', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"request_id":"r"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await worker.fetch(post('https://shop.example/k7x2qm4a', {
      origin: 'https://shop.example', 'cf-connecting-ip': '203.0.113.9',
    }), { ...env, FINGERLY_DEV_UPSTREAM: 'http://localhost:9003' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:9003/api/v1/ingest')
  })
})
