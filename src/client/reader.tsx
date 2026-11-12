import { createElement as h, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AttachmentMeta, MessageDetail, MessageSummary } from '../shared/types.js'
import { api } from './api.js'
import { Avatar, formatBytes, longDate, Modal } from './components.js'
import { Icon } from './icons.js'

export type ReaderAiAction = 'summary' | 'reply' | 'translate'

const IFRAME_STYLE = `
  html, body { margin: 0; padding: 0; }
  body {
    font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #171a21; background: #fff; padding: 20px 22px;
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
  const raw =
    detail.html !== null && detail.html !== '' ? detail.html : `<pre>${escapeHtml(detail.text)}</pre>`
  // Decode off-screen images only when they approach the viewport.
  const html = raw.replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy" decoding="async"')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(allowRemoteImages)}"><style>${IFRAME_STYLE}</style></head><body>${html}</body></html>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function hasRemoteImages(detail: MessageDetail): boolean {
  return detail.html !== null && /<img[^>]+src=["']https?:/i.test(detail.html)
}

function addressLine(list: { name: string; address: string }[]): string {
  return list.map((item) => (item.name !== '' ? `${item.name} <${item.address}>` : item.address)).join('、')
}

function threadStamp(value: string): string {
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number): string => String(part).padStart(2, '0')
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.getFullYear() === new Date().getFullYear() ? stamp : `${String(date.getFullYear())}-${stamp}`
}

function isSentMailbox(mailbox: string): boolean {
  return /(^|[/.])(sent|sent items|sent mail|已发送|发件箱)/i.test(mailbox)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function previewable(contentType: string): boolean {
  const type = contentType.toLowerCase()
  return (
    (type.startsWith('image/') && type !== 'image/svg+xml') ||
    type === 'application/pdf' ||
    type === 'text/plain' ||
    type === 'text/csv' ||
    type === 'text/markdown' ||
    type === 'application/json'
  )
}

function AttachmentPreviewText({ url }: { url: string }): ReactNode {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((response) => response.text())
      .then((value) => {
        if (!cancelled) setText(value.slice(0, 200_000))
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [url])
  if (error !== '') return h('p', { className: 'small', style: { color: 'var(--m-danger)' } }, error)
  return h('pre', { className: 'mailharbor-preview-text' }, text === '' ? '加载中…' : text)
}

function AttachmentChips({
  detail,
  source,
  mailbox,
}: {
  detail: MessageDetail
  source: 'local' | 'server'
  mailbox: string
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState<AttachmentMeta | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [projectId, setProjectId] = useState('')
  const [saveState, setSaveState] = useState('')
  useEffect(() => {
    if (preview === null || source !== 'local' || projects.length > 0) return
    let cancelled = false
    api
      .projects()
      .then((result) => {
        if (!cancelled) setProjects(result.items.map((item) => ({ id: item.id, name: item.name })))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [preview, source, projects.length])
  if (detail.attachments.length === 0) return null
  const shown = expanded ? detail.attachments : detail.attachments.slice(0, 3)
  const hidden = detail.attachments.length - shown.length
  const urlFor = (file: AttachmentMeta, inline: boolean): string =>
    source === 'server'
      ? api.attachmentUrl({
          accountId: detail.accountId,
          source: 'server',
          mailbox,
          uid: detail.uid ?? '',
          part: file.id,
          ...(inline ? { inline: 1 } : {}),
        })
      : api.attachmentUrl({
          accountId: detail.accountId,
          source: 'local',
          emailId: detail.id,
          attachmentId: file.id,
          ...(inline ? { inline: 1 } : {}),
        })
  const previewUrl = preview === null ? '' : urlFor(preview, true)
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mailharbor-attachment-chips' },
      shown.map((file) =>
        previewable(file.contentType)
          ? h(
              'button',
              {
                key: file.id,
                className: 'mailharbor-attachment',
                title: `预览 ${file.filename}`,
                onClick: () => setPreview(file),
              },
              h(Icon, { name: 'paperclip', size: 12 }),
              h('span', { className: 'name' }, file.filename),
              h('span', { className: 'muted small' }, formatBytes(file.size)),
            )
          : h(
              'a',
              {
                className: 'mailharbor-attachment',
                key: file.id,
                href: urlFor(file, false),
                download: file.filename,
                title: file.filename,
              },
              h(Icon, { name: 'paperclip', size: 12 }),
              h('span', { className: 'name' }, file.filename),
              h('span', { className: 'muted small' }, formatBytes(file.size)),
            ),
      ),
      hidden > 0
        ? h(
            'button',
            { className: 'subtle small', onClick: () => setExpanded(true) },
            `+${String(hidden)} 个附件`,
          )
        : detail.attachments.length > 3
          ? h('button', { className: 'subtle small', onClick: () => setExpanded(false) }, '收起附件')
          : null,
    ),
    preview === null
      ? null
      : h(
          Modal,
          {
            title: preview.filename,
            wide: true,
            onClose: () => setPreview(null),
            footer: h(
              'div',
              { style: { display: 'flex', gap: '8px', width: '100%', alignItems: 'center' } },
              h(
                'span',
                { className: 'small muted' },
                `${preview.contentType} · ${formatBytes(preview.size)}`,
              ),
              h('span', { className: 'spacer' }),
              saveState === '' ? null : h('span', { className: 'small muted' }, saveState),
              source === 'local' && projects.length > 0
                ? h(
                    'select',
                    {
                      value: projectId,
                      'aria-label': '保存到项目',
                      onChange: (event: { target: { value: string } }) => setProjectId(event.target.value),
                    },
                    h('option', { value: '' }, '保存到项目…'),
                    projects.map((project) =>
                      h('option', { key: project.id, value: project.id }, project.name),
                    ),
                  )
                : null,
              source === 'local' && projects.length > 0
                ? h(
                    'button',
                    {
                      className: 'ghost small',
                      disabled: projectId === '',
                      onClick: () => {
                        void api
                          .saveAttachmentToProject(projectId, detail.accountId, detail.id, preview.id)
                          .then((result) => setSaveState(`已保存 ${result.filename}`))
                          .catch(() => setSaveState('保存失败'))
                      },
                    },
                    '保存',
                  )
                : null,
              h(
                'a',
                {
                  className: 'ghost',
                  href: urlFor(preview, false),
                  download: preview.filename,
                  style: { display: 'inline-flex', alignItems: 'center', gap: '5px' },
                },
                '下载',
              ),
              h('button', { className: 'primary small', onClick: () => setPreview(null) }, '关闭'),
            ),
          },
          h(
            'div',
            {
              className: `mailharbor-preview${
                preview.contentType.toLowerCase().startsWith('image/')
                  ? ' image'
                  : preview.contentType.toLowerCase() === 'application/pdf'
                    ? ' pdf'
                    : ' text'
              }`,
            },
            preview.contentType.toLowerCase().startsWith('image/')
              ? h('img', { src: previewUrl, alt: preview.filename })
              : preview.contentType.toLowerCase() === 'application/pdf'
                ? h('iframe', { src: previewUrl, title: preview.filename })
                : h(AttachmentPreviewText, { url: previewUrl }),
          ),
        ),
  )
}

export function Reader({
  detail,
  source,
  mailbox,
  onChanged,
  onReply,
  onAiAction,
  onExtractTasks,
  onAddToProject,
  onClose,
  thread = [],
  onSelectMessage,
  loadDetail,
  folders = [],
  onStar,
  onArchive,
  onDelete,
  onMove,
}: {
  detail: MessageDetail
  source: 'local' | 'server'
  mailbox: string
  onChanged: (patch: Partial<MessageDetail>) => void
  onReply: (mode: 'reply' | 'replyAll' | 'forward') => void
  onAiAction: (action: ReaderAiAction) => void
  onExtractTasks: () => void
  onAddToProject: () => void
  onClose?: () => void
  thread?: MessageSummary[]
  onSelectMessage?: (item: MessageSummary) => void
  loadDetail?: (item: MessageSummary) => Promise<MessageDetail>
  folders?: { name: string; label: string }[]
  onStar?: (starred: boolean) => void
  onArchive?: () => void
  onDelete?: () => void
  onMove?: (target: string) => void
}): ReactNode {
  const [plain, setPlain] = useState(false)
  const [loadImages, setLoadImages] = useState(false)
  const [details, setDetails] = useState<Record<string, MessageDetail>>({})
  const [openId, setOpenId] = useState<string | null>(detail.id)
  const [detailOpen, setDetailOpen] = useState(false)
  const [moreActions, setMoreActions] = useState(false)
  const selectedCard = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const remoteImages = useMemo(() => hasRemoteImages(detail), [detail])
  const conversation = thread.length > 1 ? [...thread].reverse() : []
  const threaded = conversation.length > 0 && loadDetail !== undefined

  useEffect(() => {
    setDetails((current) => ({ ...current, [detail.id]: detail }))
    setOpenId(detail.id)
  }, [detail])

  useEffect(() => {
    selectedCard.current?.scrollIntoView({ block: 'nearest' })
  }, [detail.id])

  const toggleThread = (item: MessageSummary): void => {
    if (openId === item.id) {
      setOpenId(null)
      return
    }
    setOpenId(item.id)
    onSelectMessage?.(item)
    if (details[item.id] === undefined) {
      void loadDetail?.(item)
        .then((loaded) => setDetails((current) => ({ ...current, [item.id]: loaded })))
        .catch(() => undefined)
    }
  }
  const html = detail.html !== null && detail.html !== ''

  const toggleRead = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await api.setRead({
        id: detail.id,
        accountId: detail.accountId,
        source,
        mailbox,
        read: detail.unread,
      })
      onChanged({ unread: !result.read })
    } catch (caught) {
      setError(errorText(caught))
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
        { className: 'mailharbor-reader-title' },
        onClose === undefined
          ? null
          : h(
              'button',
              { className: 'ghost icon', onClick: onClose, 'aria-label': '返回列表', title: '返回列表' },
              h(Icon, { name: 'chevronLeft' }),
            ),
        h('h2', { style: { flex: 1 } }, detail.subject),
        onStar === undefined
          ? null
          : h(
              'button',
              {
                className: 'ghost icon',
                title: detail.starred === true ? '取消星标' : '标星',
                'aria-label': detail.starred === true ? '取消星标' : '标星',
                style: detail.starred === true ? { color: '#e0b341' } : undefined,
                onClick: () => onStar(detail.starred !== true),
              },
              h(Icon, { name: 'star', size: 15 }),
            ),
        h(
          'button',
          {
            className: 'ghost icon',
            onClick: () => void toggleRead(),
            disabled: busy,
            title: detail.unread ? '标为已读' : '标为未读',
            'aria-label': detail.unread ? '标为已读' : '标为未读',
          },
          h(Icon, { name: 'check' }),
        ),
      ),
      threaded
        ? null
        : h(
            'div',
            { className: 'mailharbor-reader-meta compact' },
            h(
              'span',
              { className: 'who' },
              h(Avatar, { email: detail.from.address, size: 22 }),
              h('strong', null, detail.from.name !== '' ? detail.from.name : detail.from.address),
              detail.from.name !== '' ? h('span', { className: 'small muted' }, detail.from.address) : null,
            ),
            h('span', { className: 'small muted' }, longDate(detail.date)),
            detail.backedUp === false ? h('span', { className: 'badge warn' }, '未备份') : null,
            h(
              'button',
              {
                className: 'subtle small',
                onClick: () => setDetailOpen(!detailOpen),
                title: '收件人与抄送',
              },
              h(Icon, { name: 'mail', size: 12 }),
              detailOpen ? '收起收件人' : '收件人/抄送',
              h(Icon, { name: detailOpen ? 'chevronLeft' : 'chevronRight', size: 12 }),
            ),
          ),
      threaded || !detailOpen || (detail.to.length === 0 && detail.cc.length === 0)
        ? null
        : h(
            'div',
            { className: 'mailharbor-reader-recipients' },
            detail.to.length === 0 ? null : h('span', null, `收件人：${addressLine(detail.to)}`),
            detail.cc.length === 0 ? null : h('span', null, `抄送：${addressLine(detail.cc)}`),
          ),
      h(
        'div',
        { className: moreActions ? 'mailharbor-reader-actions expanded' : 'mailharbor-reader-actions' },
        h(
          'button',
          { className: 'ghost', onClick: () => onReply('reply') },
          h(Icon, { name: 'reply' }),
          '回复',
        ),
        h(
          'button',
          { className: 'ghost', onClick: () => onReply('replyAll') },
          h(Icon, { name: 'replyAll' }),
          '全部回复',
        ),
        h(
          'button',
          { className: 'ghost', onClick: () => onReply('forward') },
          h(Icon, { name: 'forward' }),
          '转发',
        ),
        h(
          'button',
          {
            className: 'ghost mailharbor-more-toggle',
            'aria-expanded': moreActions,
            onClick: () => setMoreActions(!moreActions),
          },
          moreActions ? '收起' : '更多',
          h(Icon, { name: moreActions ? 'chevronLeft' : 'chevronRight', size: 12 }),
        ),
        h('span', { className: 'mailharbor-divider mailharbor-secondary' }),
        onArchive === undefined
          ? null
          : h(
              'button',
              { className: 'ghost mailharbor-secondary', onClick: onArchive, title: '移到归档文件夹' },
              h(Icon, { name: 'archive', size: 14 }),
              '归档',
            ),
        onDelete === undefined
          ? null
          : h(
              'button',
              { className: 'ghost mailharbor-secondary', onClick: onDelete, title: '移到垃圾箱' },
              h(Icon, { name: 'trash', size: 14 }),
              '删除',
            ),
        onMove === undefined || folders.length === 0
          ? null
          : h(
              'select',
              {
                className: 'mailharbor-secondary',
                value: '',
                'aria-label': '移动到文件夹',
                title: '移动到文件夹',
                onChange: (event: { target: { value: string; selectedIndex?: number } }) => {
                  const target = event.target.value
                  if (target !== '') onMove(target)
                },
              },
              h('option', { value: '' }, '移动到…'),
              folders.map((folder) => h('option', { key: folder.name, value: folder.name }, folder.label)),
            ),
        h('span', { className: 'mailharbor-divider mailharbor-secondary' }),
        h(
          'button',
          { className: 'ghost mailharbor-secondary', onClick: () => onAiAction('summary') },
          h(Icon, { name: 'sparkles', size: 14 }),
          'AI 摘要',
        ),
        h(
          'button',
          { className: 'ghost mailharbor-secondary', onClick: () => onAiAction('reply') },
          'AI 回复',
        ),
        h(
          'button',
          { className: 'ghost mailharbor-secondary', onClick: () => onAiAction('translate') },
          'AI 翻译',
        ),
        h(
          'button',
          { className: 'ghost mailharbor-secondary', onClick: onExtractTasks },
          h(Icon, { name: 'checklist', size: 14 }),
          '提取任务',
        ),
        h(
          'button',
          { className: 'ghost mailharbor-secondary', onClick: onAddToProject },
          h(Icon, { name: 'folder', size: 14 }),
          '加入项目',
        ),
        h('span', { className: 'spacer' }),
        html
          ? h(
              'button',
              { className: 'subtle', onClick: () => setPlain(!plain) },
              plain ? '显示 HTML' : '纯文本',
            )
          : null,
        remoteImages && !loadImages
          ? h(
              'button',
              { className: 'subtle', onClick: () => setLoadImages(true) },
              h(Icon, { name: 'image', size: 14 }),
              '显示图片',
            )
          : null,
      ),
      error === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-danger)' } }, error),
    ),
    threaded
      ? h(
          'div',
          { className: 'mailharbor-thread-view' },
          h(
            'div',
            { className: 'mailharbor-thread-hint' },
            h(Icon, { name: 'mail', size: 13 }),
            `共 ${String(conversation.length)} 封 · 点击任意一封展开或收起`,
          ),
          conversation.map((item) => {
            const expandedItem = openId === item.id
            const itemDetail = details[item.id]
            const sentItem = isSentMailbox(mailbox) && item.to.length > 0
            const who = sentItem ? (item.to[0] ?? item.from) : item.from
            const selectedItem = item.id === detail.id
            const toLine =
              addressLine(item.to) || (itemDetail === undefined ? '' : addressLine(itemDetail.to))
            const ccLine = itemDetail === undefined ? '' : addressLine(itemDetail.cc)
            return h(
              'div',
              {
                key: item.id,
                ref: selectedItem ? selectedCard : undefined,
                className: `mailharbor-thread-msg${selectedItem ? ' selected' : ''}${expandedItem ? ' open' : ''}`,
              },
              h(
                'button',
                { className: 'mailharbor-thread-head', onClick: () => toggleThread(item) },
                h(Avatar, { email: who.address, size: 26 }),
                h(
                  'span',
                  { className: 'thread-main' },
                  h(
                    'span',
                    { className: 'thread-line' },
                    h('strong', { className: 'thread-name' }, who.name !== '' ? who.name : who.address),
                    item.unread ? h('span', { className: 'dot', title: '未读' }) : null,
                    item.hasAttachments ? h(Icon, { name: 'paperclip', size: 12 }) : null,
                    sentItem && item.to.length > 1
                      ? h('span', { className: 'thread-count' }, `发给 ${String(item.to.length)} 人`)
                      : null,
                    h('span', { className: 'spacer' }),
                    h(
                      'span',
                      { className: 'thread-date', title: longDate(item.date) },
                      threadStamp(item.date),
                    ),
                  ),
                ),
                expandedItem
                  ? h(Icon, { name: 'chevronLeft', size: 14 })
                  : h(Icon, { name: 'chevronRight', size: 14 }),
              ),
              expandedItem
                ? h(
                    'div',
                    { className: 'mailharbor-thread-body' },
                    toLine === '' && ccLine === ''
                      ? null
                      : h(
                          'div',
                          { className: 'mailharbor-thread-recipients small muted' },
                          toLine === '' ? null : h('span', null, `收件人：${toLine}`),
                          ccLine === '' ? null : h('span', null, `抄送：${ccLine}`),
                        ),
                    itemDetail === undefined
                      ? h(
                          'div',
                          { className: 'thread-loading small muted' },
                          h('span', { className: 'mailharbor-spinner' }),
                          '正在读取…',
                        )
                      : h(
                          'div',
                          null,
                          h(
                            'div',
                            { className: 'mailharbor-thread-frame' },
                            h('iframe', {
                              title: `邮件正文 ${item.id}`,
                              sandbox: '',
                              srcDoc: srcDoc(itemDetail, loadImages),
                              referrerPolicy: 'no-referrer',
                            }),
                          ),
                          h(AttachmentChips, { detail: itemDetail, source, mailbox }),
                        ),
                  )
                : null,
            )
          }),
        )
      : h(
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
    threaded ? null : h(AttachmentChips, { detail, source, mailbox }),
  )
}
