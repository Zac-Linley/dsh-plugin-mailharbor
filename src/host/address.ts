import type { Address } from '../shared/types.js'

/** Split `a@b, "Doe, John" <c@d>` on commas that are not inside quotes or angle brackets. */
export function splitAddressHeader(value: string): string[] {
  const text = value.trim()
  if (text === '') return []
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = 0
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    if (ch === '<' && !quoted) angle += 1
    if (ch === '>' && !quoted && angle > 0) angle -= 1
    if ((ch === ',' || ch === ';') && !quoted && angle === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** Parse one address token into `{ name, address }`. */
export function parseAddress(token: string): Address | null {
  const text = token.trim()
  if (text === '') return null
  const angled = /^(.*?)\s*<([^>]+)>\s*$/.exec(text)
  if (angled !== null) {
    const name = (angled[1] ?? '').trim().replace(/^"|"$/g, '').trim()
    const address = (angled[2] ?? '').trim()
    return address === '' ? null : { name, address }
  }
  if (/^[^\s@]+@[^\s@]+$/.test(text)) return { name: '', address: text }
  return null
}

/** Parse a whole To/Cc header. Invalid tokens are dropped. */
export function parseAddressList(value: string): Address[] {
  return splitAddressHeader(value)
    .map(parseAddress)
    .filter((address): address is Address => address !== null)
}

/** Format addresses back into a header value. */
export function formatAddressList(list: Address[]): string {
  return list
    .map((address) => (address.name !== '' ? `${address.name} <${address.address}>` : address.address))
    .filter((text) => text !== '')
    .join(', ')
}

/** First address of a list, or an empty address. */
export function firstAddress(list: Address[] | undefined): Address {
  const first = list?.[0]
  return first === undefined ? { name: '', address: '' } : { name: first.name, address: first.address }
}

/** The bare address from `Name <a@b>` or `a@b`. */
export function addressOf(value: string): string {
  const angled = /<([^>]+)>/.exec(value)
  return (angled === null ? value : (angled[1] ?? '')).trim()
}

/** Validate a single address without a full RFC parser. */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value.trim())
}
