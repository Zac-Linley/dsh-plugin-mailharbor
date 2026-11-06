import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account, DraftAttachment } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { Field, Modal } from './components.js'

export interface ComposeInit {
  mode: 'new' | 'reply' | 'replyAll' | 'forward'
  accountId?: string
  to: string
  cc: string
  bcc: string
  subject: string
  html: string
  inReplyTo?: string
  references?: string
  draftId?: string
  attachments?: DraftAttachment[]
}

function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export function Composer({
  account,
  initial,
  onClose,
  onSent,
}: {
  account: Account
  initial: ComposeInit
  onClose: () => void
  onSent: (message: string) => void
}): ReactNode {
  const [to, setTo] = useState(initial.to)
  const [cc, setCc] = useState(initial.cc)
  const [bcc, setBcc] = useState(initial.bcc)
  const [subject, setSubject] = useState(initial.subject)
  const [showCc, setShowCc] = useState(initial.cc !== '' || initial.bcc !== '')
  const [attachments, setAttachments] = useState<DraftAttachment[]>(initial.attachments ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [draftId, setDraftId] = useState(initial.draftId)
  const [translating, setTranslating] = useState<'zh' | 'en' | null>(null)
  const [pendingLang, setPendingLang] = useState<'zh' | 'en' | null>(null)
  const editor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editor.current !== null) editor.current.innerHTML = initial.html
    // The initial body is applied once; later edits own the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const html = (): string => editor.current?.innerHTML ?? ''
  const text = (): string => editor.current?.innerText ?? ''

  const exec = (command: string, value?: string): void => {
    editor.current?.focus()
    document.execCommand(command, false, value)
  }

  const translate = async (target: 'zh' | 'en'): Promise<void> => {
    if (editor.current === null) return
    if (html().trim() === '') {
      setError('正文为空，无法翻译')
      return
    }
    setPendingLang(null)
    setTranslating(target)
    setError('')
    try {
      const result = await api.aiTranslate({ accountId: account.id, html: html(), target })
      editor.current.innerHTML = result.html
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setTranslating(null)
    }
  }

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setError('')
    const next = [...attachments]
    let total = next.reduce((sum, file) => sum + file.data.length, 0)
    for (const file of Array.from(files)) {
      if (total + file.size > 8 * 1024 * 1024) {
        setError('附件合计不能超过 8 MB')
        break
      }
      const data = await readFileBase64(file)
      next.push({ filename: file.name, contentType: file.type || 'application/octet-stream', data })
      total += file.size
    }
    setAttachments(next)
  }

  const saveDraft = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const { draft } = await api.saveDraft(account.id, {
        ...(draftId === undefined ? {} : { id: draftId }),
        to,
        cc,
        bcc,
        subject,
        html: html(),
        attachments,
        ...(initial.inReplyTo === undefined ? {} : { inReplyTo: initial.inReplyTo }),
        ...(initial.references === undefined ? {} : { references: initial.references }),
      })
      setDraftId(draft.id)
      onSent('草稿已保存')
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const send = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.send(account.id, {
        to,
        cc,
        bcc,
        subject,
        html: html(),
        text: text(),
        attachments,
        ...(initial.inReplyTo === undefined ? {} : { inReplyTo: initial.inReplyTo }),
        ...(initial.references === undefined ? {} : { references: initial.references }),
      })
      if (draftId !== undefined) {
        try {
          await api.deleteDraft(draftId, account.id)
        } catch {
          // The sent message matters more than removing its draft.
        }
      }
      onSent('邮件已发送')
      onClose()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return h(
    Modal,
    {
      title:
        initial.mode === 'reply'
          ? '回复'
          : initial.mode === 'replyAll'
            ? '全部回复'
            : initial.mode === 'forward'
              ? '转发'
              : '写邮件',
      onClose,
      wide: true,
      footer: h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', width: '100%' } },
        h('span', { className: 'small muted' }, `发件人 ${account.email}`),
        h('span', { className: 'spacer' }),
        h('button', { className: 'ghost', onClick: () => void saveDraft(), disabled: busy }, '存草稿'),
        confirming
          ? h(
              'span',
              { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
              h('span', { className: 'small' }, '确定发送？'),
              h(
                'button',
                { className: 'primary', onClick: () => void send(), disabled: busy },
                busy ? '发送中…' : '确定',
              ),
              h('button', { className: 'ghost', onClick: () => setConfirming(false) }, '取消'),
            )
          : h(
              'button',
              {
                className: 'primary',
                onClick: () => setConfirming(true),
                disabled: busy || to.trim() === '',
              },
              '发送',
            ),
      ),
    },
    error === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-danger)' } }, error),
    h(
      'div',
      { className: 'mailharbor-grid' },
      h(
        Field,
        { label: '收件人' },
        h('input', {
          value: to,
          onChange: (event: { target: { value: string } }) => setTo(event.target.value),
          placeholder: 'a@example.com, b@example.com',
        }),
      ),
      h(
        Field,
        { label: '主题' },
        h('input', {
          value: subject,
          onChange: (event: { target: { value: string } }) => setSubject(event.target.value),
        }),
      ),
    ),
    showCc
      ? h(
          'div',
          { className: 'mailharbor-grid' },
          h(
            Field,
            { label: '抄送' },
            h('input', {
              value: cc,
              onChange: (event: { target: { value: string } }) => setCc(event.target.value),
            }),
          ),
          h(
            Field,
            { label: '密送' },
            h('input', {
              value: bcc,
              onChange: (event: { target: { value: string } }) => setBcc(event.target.value),
            }),
          ),
        )
      : h(
          'button',
          { className: 'subtle small', style: { alignSelf: 'flex-start' }, onClick: () => setShowCc(true) },
          '添加抄送 / 密送',
        ),
    h(
      'div',
      { className: 'mailharbor-toolbar' },
      h('button', { onClick: () => exec('bold'), title: '加粗' }, 'B'),
      h('button', { onClick: () => exec('italic'), title: '斜体' }, 'I'),
      h('button', { onClick: () => exec('underline'), title: '下划线' }, 'U'),
      h('button', { onClick: () => exec('insertUnorderedList'), title: '无序列表' }, '• 列表'),
      h('button', { onClick: () => exec('insertOrderedList'), title: '有序列表' }, '1. 列表'),
      h('button', { onClick: () => exec('formatBlock', 'blockquote'), title: '引用' }, '引用'),
      h(
        'button',
        {
          onClick: () => {
            const url = window.prompt('链接地址（https://…）')
            if (url !== null && /^https?:\/\//i.test(url)) exec('createLink', url)
          },
          title: '链接',
        },
        '链接',
      ),
      h('button', { onClick: () => exec('removeFormat'), title: '清除格式' }, '清除'),
      h('span', { className: 'spacer' }),
      h(
        'button',
        { onClick: () => setPendingLang('zh'), disabled: translating !== null, title: 'AI 翻译成中文' },
        translating === 'zh' ? '翻译中…' : '中',
      ),
      h(
        'button',
        { onClick: () => setPendingLang('en'), disabled: translating !== null, title: 'AI 翻译成英文' },
        translating === 'en' ? '…' : 'EN',
      ),
      h(
        'label',
        { className: 'mailharbor-toggle small' },
        '附件',
        h('input', {
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: (event: { target: { files: FileList | null; value: string } }) => {
            void addFiles(event.target.files)
            event.target.value = ''
          },
        }),
      ),
    ),
    pendingLang === null
      ? null
      : h(
          'div',
          { className: 'mailharbor-confirm' },
          h('span', null, pendingLang === 'en' ? '把正文翻译成英文？' : '把正文翻译成中文？'),
          h('span', { className: 'spacer' }),
          h('button', { className: 'ghost', onClick: () => setPendingLang(null) }, '取消'),
          h('button', { className: 'primary', onClick: () => void translate(pendingLang) }, '翻译'),
        ),
    attachments.length === 0
      ? null
      : h(
          'div',
          { className: 'mailharbor-attachments', style: { padding: 0, border: 0 } },
          attachments.map((file, index) =>
            h(
              'span',
              { className: 'mailharbor-attachment', key: `${file.filename}:${String(index)}` },
              h('span', { className: 'name' }, file.filename),
              h(
                'button',
                {
                  className: 'subtle',
                  onClick: () => setAttachments(attachments.filter((_item, position) => position !== index)),
                },
                '✕',
              ),
            ),
          ),
        ),
    h('div', {
      className: 'mailharbor-editor',
      ref: editor,
      contentEditable: true,
      suppressContentEditableWarning: true,
      'data-placeholder': '写点什么…',
      spellCheck: true,
    }),
  )
}
