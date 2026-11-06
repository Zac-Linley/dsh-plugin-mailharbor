import { createElement as h, useEffect, useState, type ReactNode } from 'react'
import { api } from './api.js'

/** Sidebar entry: an envelope with an unread badge, polled at a low rate. */
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
      }, 60_000)
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
      style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
    },
    h(
      'svg',
      { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
      h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', {
        d: 'M3.5 7l7.6 5.4a1.6 1.6 0 0 0 1.8 0L20.5 7',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
      }),
    ),
    unread > 0
      ? h(
          'span',
          {
            style: {
              position: 'absolute',
              top: '-4px',
              right: '-6px',
              minWidth: '14px',
              height: '14px',
              padding: '0 3px',
              borderRadius: '999px',
              background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
              color: '#fff',
              fontSize: '9px',
              lineHeight: '14px',
              textAlign: 'center',
              fontWeight: 600,
            },
          },
          unread > 99 ? '99+' : String(unread),
        )
      : null,
  )
}
