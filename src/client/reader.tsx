import { createElement as h, useMemo, useState, type ReactNode } from 'react'
import type { Account, MessageDetail } from '../shared/types.js'
import { api } from './api.js'
import { formatBytes, longDate } from './components.js'

const IFRAME_STYLE = `
  html, body { margin: 0; padding: 0; }
  body {
    font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #171a21; background: #fff; padding: 18px 20px;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; border-collapse: collapse; }
  td, th { padding: 2px 6px; }
  a { color: #2f5bd3; }
  blockquote { margin: 0 0 0 12px; padding-left: 12px; border-left: 2px solid #d7dbe3; color: #565c67; }
  pre { white-space: pre-wrap; }
`

function csp(allowRemoteImages: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'font-src data:',
    `img-src data:${allowRemoteImages ? ' https: http:' : ''}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

function srcDoc(detail: MessageDetail, allowRemoteImages: boolean): string {
  const html =
    detail.html !== null && detail.html !== '' ? detail.html : `<pre>${escapeHtml(detail.text)}</pre>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(allowRemoteImages)}"><style>${IFRAME_STYLE}</style></head><body>${html}</body></html>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function hasRemoteImages(detail: MessageDetail): boolean {
  return detail.html !== null && /<img[^>]+src=["']https?:/i.test(detail.html)
}

export function Reader({
  detail,
  account,
  source,
  mailbox,
  onChanged,
  onReply,
  onClose,
}: {
  detail: MessageDetail
  account: Account
  source: 'local' | 'server'
  mailbox: string
  onChanged: (patch: Partial<MessageDetail>) => void
  onReply: (mode: 'reply' | 'replyAll' | 'forward') => void
  onClose?: () => void
}): ReactNode {
  const [plain, setPlain] = useState(false)
  const [loadImages, setLoadImages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const remoteImages = useMemo(() => hasRemoteImages(detail), [detail])
  const html = detail.html !== null && detail.html !== ''

  const toggleRead = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await api.setRead({
        id: detail.id,
        accountId: account.id,
        source,
        mailbox,
        read: detail.unread,
      })
      onChanged({ unread: !result.read })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return h(
    'div',
    { className: 'mailharbor-reader' },
    h(
      'div',
      { className: 'mailharbor-reader-head' },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('h2', { style: { flex: 1 } }, detail.subject),
        onClose === undefined ? null : h('button', { className: 'ghost', onClick: onClose }, '返回列表'),
      ),
      h(
        'div',
        { className: 'mailharbor-reader-meta' },
        h(
          'span',
          null,
          `${detail.from.name !== '' ? detail.from.name : detail.from.address} <${detail.from.address}>`,
        ),
        h('span', null, longDate(detail.date)),
        detail.backedUp === false ? h('span', { className: 'badge warn' }, '未备份') : null,
      ),
      h(
        'div',
        { className: 'mailharbor-reader-meta' },
        h(
          'span',
          null,
          `收件人: ${detail.to.map((item) => (item.name !== '' ? `${item.name} <${item.address}>` : item.address)).join(', ') || '—'}`,
        ),
        detail.cc.length === 0
          ? null
          : h('span', null, `抄送: ${detail.cc.map((item) => item.address).join(', ')}`),
      ),
      h(
        'div',
        { className: 'mailharbor-reader-actions' },
        h(
          'button',
          {
            className: 'primary',
            onClick: () => {
              onReply('reply')
            },
          },
          '回复',
        ),
        h(
          'button',
          {
            className: 'ghost',
            onClick: () => {
              onReply('replyAll')
            },
          },
          '全部回复',
        ),
        h(
          'button',
          {
            className: 'ghost',
            onClick: () => {
              onReply('forward')
            },
          },
          '转发',
        ),
        h('span', { className: 'spacer' }),
        h(
          'button',
          { className: 'ghost', onClick: () => void toggleRead(), disabled: busy },
          detail.unread ? '标为已读' : '标为未读',
        ),
        html
          ? h(
              'button',
              { className: 'ghost', onClick: () => setPlain(!plain) },
              plain ? '显示 HTML' : '显示纯文本',
            )
          : null,
        remoteImages && !loadImages
          ? h('button', { className: 'ghost', onClick: () => setLoadImages(true) }, '显示远程图片')
          : null,
      ),
      error === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-danger)' } }, error),
    ),
    h(
      'div',
      { className: 'mailharbor-reader-body' },
      html && !plain
        ? h('iframe', {
            title: '邮件正文',
            sandbox: '',
            srcDoc: srcDoc(detail, loadImages),
            referrerPolicy: 'no-referrer',
          })
        : h('pre', null, detail.text !== '' ? detail.text : '（无正文）'),
    ),
    detail.attachments.length === 0
      ? null
      : h(
          'div',
          { className: 'mailharbor-attachments' },
          detail.attachments.map((file) =>
            h(
              'a',
              {
                className: 'mailharbor-attachment',
                key: file.id,
                href:
                  source === 'server'
                    ? api.attachmentUrl({
                        accountId: account.id,
                        source: 'server',
                        mailbox,
                        uid: detail.uid ?? '',
                        part: file.id,
                      })
                    : api.attachmentUrl({
                        accountId: account.id,
                        source: 'local',
                        emailId: detail.id,
                        attachmentId: file.id,
                      }),
                download: file.filename,
              },
              h('span', { className: 'name' }, file.filename),
              h('span', { className: 'muted small' }, formatBytes(file.size)),
            ),
          ),
        ),
  )
}
