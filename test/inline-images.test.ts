import { describe, expect, it } from 'vitest'
import { inlineCidImages } from '../src/host/inline-images.js'

const png = new Uint8Array([137, 80, 78, 71])

describe('inlineCidImages', () => {
  it('replaces an exact Content-ID', () => {
    const html = '<p><img src="cid:logo@example.com"></p>'
    const result = inlineCidImages(html, [{ cid: '<logo@example.com>', contentType: 'image/png', data: png }])
    expect(result).toContain('src="data:image/png;base64,')
    expect(result).not.toContain('cid:')
  })

  it('falls back to the filename inside the cid (Outlook style)', () => {
    const html = '<img src="cid:image001.png@01DA2B">'
    const result = inlineCidImages(html, [{ filename: 'image001.png', contentType: 'image/png', data: png }])
    expect(result).toContain('data:image/png;base64,')
  })

  it('leaves unknown cids and non-images alone', () => {
    const html = '<img src="cid:missing"><img src="https://x/y.png">'
    const result = inlineCidImages(html, [{ cid: 'missing', contentType: 'application/pdf', data: png }])
    expect(result).toBe(html)
  })

  it('skips images above the inline size cap', () => {
    const html = '<img src="cid:big">'
    const big = new Uint8Array(2_000_001)
    expect(inlineCidImages(html, [{ cid: 'big', contentType: 'image/png', data: big }])).toBe(html)
  })
})
