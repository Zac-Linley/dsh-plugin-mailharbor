import { createElement as h, type ReactNode } from 'react'

/**
 * Small Markdown renderer for AI output.
 *
 * Supports headings, paragraphs, bold/italic/strikethrough, inline code,
 * fenced code blocks, links, lists and blockquotes. It builds React nodes, so
 * raw HTML in a model answer is shown as text, never executed.
 */

const INLINE =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_/g

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  INLINE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const key = `${keyPrefix}-${String(index++)}`
    if (match[1] !== undefined && match[2] !== undefined) {
      nodes.push(h('a', { key, href: match[2], target: '_blank', rel: 'noreferrer noopener' }, match[1]))
    } else if (match[3] !== undefined) {
      nodes.push(h('strong', { key }, match[3]))
    } else if (match[4] !== undefined) {
      nodes.push(h('strong', { key }, match[4]))
    } else if (match[5] !== undefined) {
      nodes.push(h('code', { key }, match[5]))
    } else if (match[6] !== undefined) {
      nodes.push(h('del', { key }, match[6]))
    } else if (match[7] !== undefined) {
      nodes.push(h('em', { key }, match[7]))
    } else if (match[8] !== undefined) {
      nodes.push(h('em', { key }, match[8]))
    }
    last = INLINE.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  let key = 0

  const isBlockStart = (line: string): boolean =>
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^([-*+]|\d+\.)\s+/.test(line) ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(line)

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const k = `b${String(key++)}`

    if (line.trim() === '') {
      index += 1
      continue
    }

    if (/^```/.test(line)) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push(h('pre', { key: k }, h('code', null, code.join('\n'))))
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(h('hr', { key: k }))
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = Math.min(6, (heading[1] ?? '#').length)
      blocks.push(h(`h${String(level)}`, { key: k }, inline(heading[2] ?? '', k)))
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quote.push((lines[index] ?? '').replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(h('blockquote', { key: k }, h('p', null, inline(quote.join(' '), k))))
      continue
    }

    if (/^([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line)
      const items: string[] = []
      while (index < lines.length && /^([-*+]|\d+\.)\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^([-*+]|\d+\.)\s+/, ''))
        index += 1
      }
      blocks.push(
        h(
          ordered ? 'ol' : 'ul',
          { key: k },
          items.map((item, itemIndex) =>
            h('li', { key: `${k}-${String(itemIndex)}` }, inline(item, `${k}-${String(itemIndex)}`)),
          ),
        ),
      )
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '' || (paragraph.length > 0 && isBlockStart(current))) break
      paragraph.push(current)
      index += 1
    }
    blocks.push(h('p', { key: k }, inline(paragraph.join(' '), k)))
  }

  if (blocks.length === 0) return null
  return h('div', { className: 'mailharbor-markdown' }, blocks)
}
