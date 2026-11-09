import { createElement as h, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account, AiCard, AiThread, MessageDetail, Project } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { Modal } from './components.js'
import { Icon } from './icons.js'
import { Markdown } from './markdown.js'
import type { AiReplyInit } from './reply.js'

export interface AiRequest {
  kind: 'summary' | 'reply' | 'translate'
  nonce: number
}

type Kind = 'summary' | 'reply' | 'translate' | 'answer'

interface AiStatus {
  available: boolean
  enabled: boolean
  provider: string
  model: string
  error?: string
}

function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${paragraph.trim().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('\n', '<br>')}</p>`,
    )
    .join('')
}

function summaryBlocks(text: string): { title: string; body: string }[] {
  const blocks: { title: string; body: string }[] = []
  let current: { title: string; lines: string[] } = { title: '', lines: [] }
  const push = (): void => {
    const body = current.lines.join('\n').trim()
    if (current.title !== '' || body !== '') blocks.push({ title: current.title, body })
    current = { title: '', lines: [] }
  }
  for (const line of text.split('\n')) {
    const heading =
      /^#{1,4}\s+(.*)$/.exec(line) ?? /^(结论|需要你做什么|关键信息|建议回复要点)\s*$/.exec(line)
    if (heading !== null) {
      push()
      current.title = heading[1] ?? ''
    } else {
      current.lines.push(line)
    }
  }
  push()
  return blocks
}

function suggestionsOf(summary: string): string {
  const match = /建议回复要点[：:]?\s*\n([\s\S]*)$/.exec(summary)
  if (match === null) return '根据这封邮件写一封得体的回复。'
  return `根据这些建议写回复：\n${(match[1] ?? '').trim()}`
}

const KIND_LABEL: Record<Kind, string> = {
  summary: 'AI 摘要',
  reply: 'AI 回复',
  translate: 'AI 翻译',
  answer: 'AI 回答',
}

function threadKey(detail: MessageDetail, source: 'local' | 'server'): string {
  return detail.messageId !== undefined && detail.messageId !== ''
    ? `mid:${detail.messageId}`
    : `${source}:${detail.id}`
}

/**
 * The per-mail AI workspace.
 *
 * Every output is a card stored on the Host, so closing the rail, switching
 * mail or restarting DSH never loses it. Cards end in an action: a summary can
 * spawn a reply, a reply can go to the composer or a draft, a translation can
 * be inserted, and the question box keeps the thread going.
 */
export function AiRail({
  account,
  detail,
  source,
  mailbox,
  request,
  onClose,
  onInsert,
  onSaveDraft,
  onNotice,
}: {
  account: Account | null
  detail: MessageDetail | null
  source: 'local' | 'server'
  mailbox: string
  request: AiRequest | null
  onClose: () => void
  onInsert: (init: AiReplyInit) => void
  onSaveDraft: (init: AiReplyInit) => void
  onNotice: (message: string) => void
}): ReactNode {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [thread, setThread] = useState<AiThread | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState<Kind | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [project, setProject] = useState<Project | null>(null)
  const [projectOpen, setProjectOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectRoot, setProjectRoot] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectWarnings, setProjectWarnings] = useState<string[]>([])
  const list = useRef<HTMLDivElement>(null)
  const lastNonce = useRef(0)
  const key = detail === null ? '' : threadKey(detail, source)

  useEffect(() => {
    if (account === null) return
    let cancelled = false
    api
      .aiStatus(account.id)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {
        if (!cancelled)
          setStatus({ available: false, enabled: false, provider: '', model: '', error: '无法读取 AI 状态' })
      })
    return () => {
      cancelled = true
    }
  }, [account])

  useEffect(() => {
    if (account === null || key === '') {
      setThread(null)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .aiThread(account.id, key)
      .then((result) => {
        if (!cancelled) setThread(result.thread)
      })
      .catch(() => {
        if (!cancelled) setThread(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [account, key])

  const generate = useCallback(
    async (kind: Kind, extra: Record<string, unknown> = {}): Promise<void> => {
      if (detail === null || account === null) return
      setGenerating(kind)
      setError('')
      try {
        const result = await api.aiAddCard({
          accountId: detail.accountId,
          key,
          kind,
          source,
          id: detail.id,
          mailbox,
          ...extra,
        })
        setThread(result.thread)
      } catch (caught) {
        setError(errorText(caught))
      } finally {
        setGenerating(null)
      }
    },
    [detail, account, key, source, mailbox],
  )

  // The reader's AI buttons ask the rail to run an action.
  useEffect(() => {
    if (request === null || request.nonce === lastNonce.current) return
    lastNonce.current = request.nonce
    if (detail !== null) void generate(request.kind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  useEffect(() => {
    const element = list.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [thread, generating])

  useEffect(() => {
    if (generating === null) {
      setElapsed(0)
      return
    }
    const started = Date.now()
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [generating])

  // Which project, if any, is this mail linked to?
  useEffect(() => {
    if (detail === null || account === null) {
      setProject(null)
      return
    }
    let cancelled = false
    api
      .projectFor(detail.accountId, key)
      .then((result) => {
        if (!cancelled) setProject(result.project)
      })
      .catch(() => {
        if (!cancelled) setProject(null)
      })
    return () => {
      cancelled = true
    }
  }, [detail, account, key, thread])

  const openProject = async (): Promise<void> => {
    setProjectOpen(true)
    setProjectWarnings([])
    try {
      const settings = await api.settings()
      setProjectRoot(settings.projects.root)
      setProjectName(detail?.subject.replace(/^(re|fwd):\s*/i, '').slice(0, 80) ?? '')
    } catch {
      // The dialog still works with defaults.
    }
  }

  const conversation = (): string =>
    (thread?.cards ?? [])
      .map(
        (card) =>
          `### ${KIND_LABEL[card.kind as Kind] ?? 'AI'} · ${new Date(card.createdAt).toLocaleString()}\n\n${card.output}`,
      )
      .join('\n\n')

  const transfer = async (): Promise<void> => {
    if (project === null || detail === null || account === null) return
    setProjectBusy(true)
    setProjectWarnings([])
    try {
      await api.transferProject(project.id, {
        accountId: account.id,
        key,
        conversation: conversation() === '' ? '（暂无新的 AI 记录）' : conversation(),
      })
      onNotice('已追加到项目对话')
      setProjectOpen(false)
    } catch (caught) {
      setProjectWarnings([errorText(caught)])
    } finally {
      setProjectBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (detail === null || account === null) return
    setProjectBusy(true)
    setProjectWarnings([])
    try {
      const result = await api.createProject({
        accountId: account.id,
        name: projectName.trim() === '' ? detail.subject : projectName.trim(),
        root: projectRoot,
        conversation: conversation() === '' ? '（还没有 AI 记录）' : conversation(),
        message: { key, subject: detail.subject, date: detail.date },
      })
      setProject(result.project)
      setProjectWarnings(result.warnings)
      onNotice(`项目已创建：${result.project.path}`)
      if (result.warnings.length === 0) setProjectOpen(false)
    } catch (caught) {
      setProjectWarnings([errorText(caught)])
    } finally {
      setProjectBusy(false)
    }
  }

  const replyInit = (card: AiCard): AiReplyInit => {
    const subject =
      card.meta?.subject ??
      (detail === null ? '' : /^re:/i.test(detail.subject) ? detail.subject : `Re: ${detail.subject}`)
    return {
      to: card.meta?.to ?? detail?.from.address ?? '',
      cc: '',
      subject,
      html: card.html ?? textToHtml(card.output),
      ...(card.meta?.inReplyTo !== undefined && card.meta.inReplyTo !== ''
        ? { inReplyTo: card.meta.inReplyTo }
        : {}),
      ...(card.meta?.references !== undefined && card.meta.references !== ''
        ? { references: card.meta.references }
        : {}),
    }
  }

  const copy = (card: AiCard): void => {
    void navigator.clipboard?.writeText(card.output).then(() => onNotice('已复制'))
  }

  const remove = async (card: AiCard): Promise<void> => {
    if (account === null) return
    try {
      const result = await api.aiDeleteCard(account.id, key, card.id)
      setThread(result.thread)
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const clear = async (): Promise<void> => {
    if (account === null || key === '') return
    try {
      await api.aiClearThread(account.id, key)
      setThread(null)
      setConfirmClear(false)
      onNotice('已清除这封邮件的 AI 记录')
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const ask = async (): Promise<void> => {
    const text = question.trim()
    if (text === '' || generating !== null) return
    setQuestion('')
    await generate('answer', { instruction: text })
  }

  const disabled = status !== null && (!status.available || !status.enabled)
  const cards = thread?.cards ?? []

  return h(
    'aside',
    { className: 'mailharbor-ai', 'aria-label': 'AI 助手' },
    h(
      'div',
      { className: 'mailharbor-ai-head' },
      h(Icon, { name: 'sparkles', size: 15 }),
      h('strong', null, 'AI 助手'),
      status === null || status.model === '' ? null : h('span', { className: 'badge' }, status.model),
      h('span', { className: 'spacer' }),
      confirmClear
        ? h(
            'span',
            { className: 'mailharbor-ai-confirm' },
            h('button', { className: 'subtle', onClick: () => void clear() }, '确认清除'),
            h('button', { className: 'subtle', onClick: () => setConfirmClear(false) }, '取消'),
          )
        : h(
            'button',
            {
              className: 'subtle icon',
              title: cards.length === 0 ? '关闭' : '清除这封邮件的记录',
              onClick: () => (cards.length === 0 ? onClose() : setConfirmClear(true)),
            },
            h(Icon, { name: cards.length === 0 ? 'close' : 'trash', size: 14 }),
          ),
      h(
        'button',
        { className: 'subtle icon', title: '收起', onClick: onClose },
        h(Icon, { name: 'chevronRight', size: 14 }),
      ),
    ),
    detail === null
      ? h(
          'div',
          { className: 'mailharbor-ai-empty' },
          h(Icon, { name: 'sparkles', size: 26 }),
          h('div', { className: 'title' }, '先选一封邮件'),
          h('div', { className: 'small' }, '选中邮件后，可在这里生成摘要、回复和翻译，记录会一直保留。'),
        )
      : h(
          'div',
          { className: 'mailharbor-ai-context' },
          h('span', { className: 'small' }, '跟随当前邮件'),
          h('strong', null, detail.subject),
          h(
            'span',
            { className: 'small muted' },
            project === null ? 'AI 只看到这封邮件' : `项目：${project.name}`,
          ),
        ),
    disabled && detail !== null
      ? h('div', { className: 'mailharbor-ai-warn' }, status?.error ?? 'AI 已关闭，请到设置里开启')
      : null,
    detail === null
      ? null
      : h(
          'div',
          { className: 'mailharbor-ai-quick' },
          h(
            'button',
            {
              className: 'ghost',
              disabled: disabled || generating !== null,
              onClick: () => void generate('summary'),
            },
            generating === 'summary' ? '总结中…' : '摘要',
          ),
          h(
            'button',
            {
              className: 'ghost',
              disabled: disabled || generating !== null,
              onClick: () => void generate('reply'),
            },
            generating === 'reply' ? '起草中…' : '回复',
          ),
          h(
            'button',
            {
              className: 'ghost',
              disabled: disabled || generating !== null,
              onClick: () => void generate('translate', { target: 'en' }),
            },
            generating === 'translate' ? '翻译中…' : '翻译',
          ),
          h(
            'button',
            { className: 'ghost', onClick: () => void openProject() },
            h(Icon, { name: 'folder', size: 13 }),
            '项目',
          ),
        ),
    h(
      'div',
      { className: 'mailharbor-ai-list', ref: list },
      loading ? h('div', { className: 'mailharbor-ai-empty small' }, '正在读取记录…') : null,
      !loading && detail !== null && cards.length === 0 && generating === null
        ? h(
            'div',
            { className: 'mailharbor-ai-empty' },
            h('div', { className: 'title' }, '这封邮件还没有 AI 记录'),
            h(
              'div',
              { className: 'small' },
              '点上面的「摘要」开始；生成的内容会保存在这里，关掉面板也不会丢。',
            ),
          )
        : null,
      cards.map((card) =>
        h(
          'article',
          { className: 'mailharbor-ai-card', key: card.id },
          h(
            'div',
            { className: 'mailharbor-ai-card-head' },
            h('span', null, KIND_LABEL[card.kind as Kind] ?? 'AI'),
            h('span', { className: 'muted small' }, new Date(card.createdAt).toLocaleTimeString()),
            h('span', { className: 'spacer' }),
            h(
              'button',
              {
                className: 'subtle icon',
                title: '删除',
                onClick: () => void remove(card),
              },
              h(Icon, { name: 'close', size: 12 }),
            ),
          ),
          card.kind === 'summary'
            ? h(
                'div',
                { className: 'mailharbor-ai-summary' },
                summaryBlocks(card.output).map((block, index) =>
                  h(
                    'section',
                    { key: `${block.title}:${String(index)}` },
                    block.title === '' ? null : h('h4', null, block.title),
                    h(Markdown, { text: block.body }),
                  ),
                ),
              )
            : h('div', { className: 'mailharbor-ai-text' }, h(Markdown, { text: card.output })),
          h(
            'div',
            { className: 'mailharbor-ai-card-actions' },
            card.kind === 'summary'
              ? h(
                  'button',
                  {
                    className: 'ghost',
                    disabled: generating !== null,
                    onClick: () => void generate('reply', { instruction: suggestionsOf(card.output) }),
                  },
                  '用这些要点回复',
                )
              : null,
            card.kind === 'reply' || card.kind === 'translate'
              ? h(
                  'button',
                  { className: 'ghost', onClick: () => onInsert(replyInit(card)) },
                  card.kind === 'translate' ? '插入回复' : '插入正文',
                )
              : null,
            card.kind === 'reply'
              ? h('button', { className: 'ghost', onClick: () => onSaveDraft(replyInit(card)) }, '存草稿')
              : null,
            card.kind === 'answer'
              ? h(
                  'button',
                  {
                    className: 'ghost',
                    onClick: () => setQuestion(card.output.slice(0, 80)),
                  },
                  '继续追问',
                )
              : null,
            h('span', { className: 'spacer' }),
            h('button', { className: 'subtle', onClick: () => copy(card) }, '复制'),
          ),
        ),
      ),
      generating !== null
        ? h(
            'article',
            { className: 'mailharbor-ai-card generating' },
            h('div', { className: 'mailharbor-ai-card-head' }, h('span', null, KIND_LABEL[generating])),
            h(
              'div',
              {
                className: 'mailharbor-ai-text muted',
                style: { display: 'flex', gap: '8px', alignItems: 'center' },
              },
              h('span', { className: 'mailharbor-spinner' }),
              `正在生成… ${String(elapsed)}s`,
            ),
          )
        : null,
      error === '' ? null : h('div', { className: 'mailharbor-ai-error' }, error),
    ),
    projectOpen
      ? h(
          Modal,
          {
            title: project === null ? '转到项目' : `项目：${project.name}`,
            onClose: () => setProjectOpen(false),
            footer: h(
              'div',
              { style: { display: 'flex', gap: '8px', width: '100%', alignItems: 'center' } },
              projectWarnings.length === 0
                ? h(
                    'span',
                    { className: 'small muted' },
                    project === null ? '把当前 AI 记录带进一个新工作空间' : '把当前 AI 记录追加到项目对话',
                  )
                : h(
                    'span',
                    { className: 'small', style: { color: 'var(--m-warn)' } },
                    projectWarnings.join('；'),
                  ),
              h('span', { className: 'spacer' }),
              h('button', { className: 'ghost', onClick: () => setProjectOpen(false) }, '关闭'),
              project === null
                ? h(
                    'button',
                    { className: 'primary', disabled: projectBusy, onClick: () => void create() },
                    projectBusy ? '创建中…' : '创建项目',
                  )
                : h(
                    'button',
                    { className: 'primary', disabled: projectBusy, onClick: () => void transfer() },
                    projectBusy ? '追加中…' : '追加当前记录',
                  ),
            ),
          },
          project === null
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                h(
                  'div',
                  { className: 'mailharbor-field' },
                  h('label', null, '项目名称'),
                  h('input', {
                    value: projectName,
                    onChange: (event: { target: { value: string } }) => setProjectName(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'mailharbor-field' },
                  h('label', null, '项目目录（默认可在设置里改）'),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '6px' } },
                    h('input', {
                      value: projectRoot,
                      onChange: (event: { target: { value: string } }) => setProjectRoot(event.target.value),
                    }),
                    h(
                      'button',
                      {
                        className: 'ghost',
                        title: '从文件管理器选择',
                        onClick: () => {
                          void api
                            .pickDirectory()
                            .then((result) => {
                              if (result.path !== null) setProjectRoot(result.path)
                            })
                            .catch((caught: unknown) => setProjectWarnings([errorText(caught)]))
                        },
                      },
                      h(Icon, { name: 'folder', size: 13 }),
                      '浏览…',
                    ),
                  ),
                ),
                h(
                  'p',
                  { className: 'small muted' },
                  `会创建「${projectName.trim() === '' ? '项目' : projectName.trim()}」文件夹，写入 BRIEF.md 和当前 ${String(thread?.cards.length ?? 0)} 条 AI 记录，并在侧栏注册工作空间、开一个会话。`,
                ),
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h(
                  'dl',
                  { className: 'mailharbor-kv' },
                  h('dt', null, '目录'),
                  h('dd', null, project.path),
                  h('dt', null, 'AI 记录'),
                  h('dd', null, `${String(thread?.cards.length ?? 0)} 条`),
                ),
                project.sessionId === ''
                  ? h('p', { className: 'small muted' }, '会话未创建：当前组合没有 sessions 服务。')
                  : null,
                h(
                  'p',
                  { className: 'small muted' },
                  '「追加当前记录」会把工作台里的卡片写入项目的 CONVERSATION.md。',
                ),
              ),
        )
      : null,
    detail === null
      ? null
      : h(
          'form',
          {
            className: 'mailharbor-ai-ask',
            onSubmit: (event: { preventDefault: () => void }) => {
              event.preventDefault()
              void ask()
            },
          },
          h('input', {
            value: question,
            placeholder: '问这封邮件，例如：谁需要在什么时候做什么？',
            'aria-label': '问 AI',
            disabled: disabled || generating !== null,
            onChange: (event: { target: { value: string } }) => setQuestion(event.target.value),
          }),
          h(
            'button',
            {
              className: 'primary icon',
              type: 'submit',
              disabled: disabled || generating !== null || question.trim() === '',
            },
            h(Icon, { name: 'send', size: 14 }),
          ),
        ),
  )
}
