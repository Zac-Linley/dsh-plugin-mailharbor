import { createElement as h, useEffect, useState, type ReactNode } from 'react'
import { api } from './api.js'

/**
 * Sidebar entry: an envelope plus an unread count.
 *
 * The shell renders this inside an 18×18 glyph slot and hides it from
 * assistive tech, so the badge must stay compact and must not add layout.
 * It uses the accent blue rather than `--dsw-alias-brand-primary`, which is
 * near-white in the dark theme and would render as an empty white blob.
 */
export function MailIcon(): ReactNode {
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const result = await api.unread()
        if (!cancelled) setUnread(result.unread)
      } catch {
        // A logged-out or offline account simply shows no badge.
      }
    }
    void poll()
    const schedule = (): void => {
      if (cancelled) return
      timer = window.setTimeout(() => {
        void poll().finally(schedule)
      }, 30_000)
    }
    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  return h(
    'span',
    {
      style: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '18px',
        boxSizing: 'border-box',
      },
    },
    h(
      'svg',
      { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
      h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.7 }),
      h('path', {
        d: 'M3.5 7l7.6 5.4a1.6 1.6 0 0 0 1.8 0L20.5 7',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
      }),
    ),
    unread > 0
      ? h(
          'span',
          {
            style: {
              position: 'absolute',
              right: '-5px',
              bottom: '-3px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              minWidth: '13px',
              height: '13px',
              padding: '0 3px',
              borderRadius: '999px',
              background: '#5686fe',
              color: '#fff',
              fontSize: '9px',
              fontWeight: 600,
              lineHeight: '13px',
              zIndex: 1,
              letterSpacing: '-0.01em',
              fontVariantNumeric: 'tabular-nums',
              boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, #151517)',
              pointerEvents: 'none',
            },
          },
          unread > 99 ? '99+' : String(unread),
        )
      : null,
  )
}
