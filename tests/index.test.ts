import { describe, expect, it } from 'vitest'
import worker, { testing, type Env } from '../src/index.js'

const env: Env = {
  FINGERLY_PROXY_KEY: 'fly_px_eu_production_proxy', FINGERLY_ROUTE_PREFIX: '/neutral',
  FINGERLY_ALLOWED_ORIGINS: 'https://shop.example',
}

describe('routing', () => {
  it('derives only allowlisted regional upstreams', () => {
    expect(testing.regionFromProxyKey('fly_px_eu_production_x')).toBe('eu')
    expect(testing.regionFromProxyKey('fly_px_us_staging_x')).toBe('us')
    expect(testing.regionFromProxyKey('fly_px_ap_production_x')).toBeNull()
  })

  it('allows only identify and supplement tails', () => {
    expect(testing.routeTail('/neutral/api/v1/identify', '/neutral')).toBe('/api/v1/identify')
    expect(testing.routeTail('/neutral/api/v1/events/abc_123/supplement', '/neutral')).toBe('/api/v1/events/abc_123/supplement')
    expect(testing.routeTail('/neutral/api/v1/events', '/neutral')).toBeNull()
  })
})

describe('worker boundary', () => {
  it('refuses unapproved origins and unknown routes', async () => {
    const wrongOrigin = new Request('https://shop.example/neutral/api/v1/identify', {
      method: 'POST', headers: { origin: 'https://evil.example', 'x-api-key': 'public' }, body: '{}',
    })
    expect((await worker.fetch(wrongOrigin, env)).status).toBe(403)
    const unknown = new Request('https://shop.example/neutral/admin', {
      method: 'POST', headers: { origin: 'https://shop.example', 'x-api-key': 'public' }, body: '{}',
    })
    expect((await worker.fetch(unknown, env)).status).toBe(404)
  })

  it('answers a valid preflight without exposing credentials', async () => {
    const request = new Request('https://shop.example/neutral/api/v1/identify', {
      method: 'OPTIONS', headers: { origin: 'https://shop.example' },
    })
    const result = await worker.fetch(request, env)
    expect(result.status).toBe(204)
    expect(result.headers.get('access-control-allow-origin')).toBe('https://shop.example')
    expect(result.headers.get('access-control-expose-headers')).toContain('fingerly-balance-micros')
  })
})
