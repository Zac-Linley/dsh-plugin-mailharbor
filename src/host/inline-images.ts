export interface InlineImage {
  /** Content-ID without angle brackets, when the backup recorded one. */
  cid?: string
  filename?: string
  contentType: string
  data?: Uint8Array
}

const MAX_INLINE_BYTES = 2_000_000

function normalize(value: string): string {
  return value.trim().replace(/^<|>$/g, '').toLowerCase()
}

function dataUrl(image: InlineImage): string | null {
  if (image.data === undefined || !image.contentType.toLowerCase().startsWith('image/')) return null
  if (image.data.byteLength > MAX_INLINE_BYTES) return null
  return `data:${image.contentType};base64,${Buffer.from(image.data).toString('base64')}`
}

/**
 * Rewrite `cid:` image references in a mail body to inline data URLs.
 *
 * Inline images were previously dropped from the attachment list, which left
 * `cid:` URLs in the HTML that the sandbox CSP blocks. Matching is exact on the
 * Content-ID first, then falls back to a filename contained in the cid value
 * (the common Outlook `image001.png@...` shape).
 */
export function inlineCidImages(html: string, images: InlineImage[]): string {
  if (!/cid:/i.test(html)) return html
  const byCid = new Map<string, string>()
  const byName: { name: string; url: string }[] = []
  for (const image of images) {
    const url = dataUrl(image)
    if (url === null) continue
    if (image.cid !== undefined && image.cid.trim() !== '') byCid.set(normalize(image.cid), url)
    if (image.filename !== undefined && image.filename.trim() !== '') {
      byName.push({ name: normalize(image.filename), url })
    }
  }
  if (byCid.size === 0 && byName.length === 0) return html

  return html.replace(/cid:([^"'\s)>]+)/gi, (match, rawCid: string) => {
    const cid = normalize(rawCid)
    const exact = byCid.get(cid)
    if (exact !== undefined) return exact
    const named = byName.find((entry) => cid.includes(entry.name))
    return named === undefined ? match : named.url
  })
}
