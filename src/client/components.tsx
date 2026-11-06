import { createElement as h, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Avatar({ email, size = 26 }: { email: string; size?: number }): ReactNode {
  const letter = (email.trim()[0] ?? '?').toUpperCase()
  return h(
    'span',
    {
      className: 'avatar',
      style: {
        width: `${String(size)}px`,
        height: `${String(size)}px`,
        fontSize: `${String(Math.round(size * 0.42))}px`,
      },
      'aria-hidden': 'true',
    },
    letter,
  )
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children?: ReactNode
  hint?: string
}): ReactNode {
  return h(
    'div',
    { className: 'mailharbor-field' },
    h('label', null, label),
    children,
    hint === undefined ? null : h('span', { className: 'small muted' }, hint),
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}): ReactNode {
  return h(
    'label',
    { className: 'mailharbor-toggle' },
    h('input', {
      type: 'checkbox',
      checked,
      onChange: (event: { target: { checked: boolean } }) => {
        onChange(event.target.checked)
      },
    }),
    label,
  )
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide = false,
}: {
  title: string
  children?: ReactNode
  footer?: ReactNode
  onClose: () => void
  wide?: boolean
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return createPortal(
    h(
      'div',
      {
        className: 'mailharbor-modal-mask',
        onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      h(
        'div',
        {
          className: 'mailharbor-modal',
          style: wide ? { width: 'min(920px, 100%)' } : undefined,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
        },
        h(
          'header',
          null,
          title,
          h('span', { className: 'spacer' }),
          h('button', { className: 'subtle', onClick: onClose, 'aria-label': '关闭' }, '✕'),
        ),
        h('div', { className: 'content' }, children),
        footer === undefined ? null : h('footer', null, footer),
      ),
    ),
    document.body,
  )
}

export function ErrorBar({ message, onDismiss }: { message: string; onDismiss: () => void }): ReactNode {
  return h(
    'div',
    { className: 'error', role: 'alert' },
    h('span', null, message),
    h('span', { className: 'spacer' }),
    h('button', { className: 'subtle', onClick: onDismiss }, '关闭'),
  )
}

const DAY = 86_400_000

/** Compact list timestamp: time today, month-day this year, else the date. */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Full timestamp for the reader header. */
export function longDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function isFresh(iso: string, windowMs = DAY): boolean {
  const time = new Date(iso).getTime()
  return !Number.isNaN(time) && Date.now() - time < windowMs
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
