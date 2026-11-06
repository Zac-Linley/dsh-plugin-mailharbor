import { createElement as h, type ReactNode } from 'react'

const PATHS: Record<string, ReactNode> = {
  refresh: h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6' }),
  plus: h('path', { d: 'M12 5v14M5 12h14' }),
  compose: h('path', { d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3' }),
  archive: h(
    'g',
    null,
    h('rect', { x: 3, y: 4, width: 18, height: 5, rx: 1.5 }),
    h('path', { d: 'M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4' }),
  ),
  paperclip: h('path', {
    d: 'M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3',
  }),
  mail: h(
    'g',
    null,
    h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
    h('path', { d: 'm4 7 7.1 5a1.6 1.6 0 0 0 1.8 0L20 7' }),
  ),
  search: h('path', { d: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4' }),
  reply: h('path', { d: 'M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1' }),
  replyAll: h('path', { d: 'm9 7-5 5 5 5M14 7l-5 5 5 5M13 12h5a5 5 0 0 1 5 5' }),
  forward: h('path', { d: 'm15 7 5 5-5 5M20 12h-9a6 6 0 0 0-6 6v1' }),
  check: h('path', { d: 'm5 13 4 4L19 7' }),
  image: h(
    'g',
    null,
    h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
    h('circle', { cx: 8.5, cy: 9.5, r: 1.5 }),
    h('path', { d: 'm4 18 5-5 4 4 3-3 4 4' }),
  ),
  close: h('path', { d: 'M6 6l12 12M18 6 6 18' }),
  chevronLeft: h('path', { d: 'm14 6-6 6 6 6' }),
  chevronRight: h('path', { d: 'm10 6 6 6-6 6' }),
  sparkles: h(
    'g',
    null,
    h('path', { d: 'm12 3 1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z' }),
    h('path', { d: 'M18.5 15.5 19.3 18l2.2.8-2.2.7-.8 2.5-.8-2.5-2.2-.7 2.2-.8z' }),
  ),
  trash: h(
    'g',
    null,
    h('path', {
      d: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12',
    }),
    h('path', { d: 'M10 11v6M14 11v6' }),
  ),
  send: h('path', { d: 'm4 4 17 8-17 8 3.6-8z M7.6 12H21' }),
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }): ReactNode {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    PATHS[name] ?? null,
  )
}
