import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Account, MessageDetail } from '../shared/types.js'
import type { MailHarborConfig } from './config.js'
import type { DshLlm } from './dsh.js'

export interface StyleProfile {
  /** Free-form Chinese description of the user's writing habits. */
  profile: string
  updatedAt: string
  sampleCount: number
}

export interface AiStatus {
  available: boolean
  enabled: boolean
  provider: string
  model: string
  styleUpdatedAt: string
  styleSampleCount: number
  error?: string
}

export interface AiDeps {
  config: () => MailHarborConfig
  llm: () => DshLlm | undefined
  /** Directory that holds the account's mail data (style profile lives here). */
  accountRoot: (account: Account) => string
}

const TIMEOUT_MS = 90_000
const MAX_PROMPT_CHARS = 40_000

const SUMMARY_SYSTEM = `你是邮件助理，服务于中文用户。请用简体中文总结邮件，严格按下面四段输出，使用给定的小标题，不要输出其他内容：

结论
（1-2 句话说明这封邮件是什么事）

需要你做什么
（没有就写「无需操作」；有就列 1-3 条，项目符号）

关键信息
（时间、金额、人名、单号、地址等，项目符号；没有就写「无」）

建议回复要点
（1-3 条中文要点）

只依据邮件内容，不要编造，不要输出思考过程。`

const REPLY_SYSTEM = (
  language: string,
  style: string,
): string => `你是邮件写作助理。根据原始邮件和用户的要求，写一封可以直接发送的回复正文。

要求：
- 语言：${language === 'en' ? '英文' : '简体中文'}
- 不要写主题行，不要输出 Markdown 标记，不要解释你在做什么
- 语气专业、简洁、礼貌；中文用「您」，英文避免过度正式
- 只输出正文本身（称呼、正文、结尾），不要引号包裹
${style === '' ? '' : `\n写作风格（模仿但不生硬）：\n${style}`}`

const TRANSLATE_SYSTEM = (
  target: string,
): string => `你是邮件翻译。把用户给出的邮件正文翻译成${target === 'en' ? '英文' : '简体中文'}。

规则：
- 只输出译文，不添加解释
- 保留段落结构
- 如果正文是 HTML，保留原有标签、链接和图片，只翻译可见文字
- 专有名词、邮箱地址、链接、单号保持不变`

const ASK_SYSTEM = `你是邮件助手。基于用户提供的邮件和已有的 AI 记录回答问题。

要求：
- 用简体中文回答，简洁直接
- 只依据邮件内容和已有记录，不确定就说明「邮件里没有提到」
- 不要复述问题，不要输出思考过程`

const COMPOSE_SYSTEM = (mode: 'draft' | 'polish' | 'shorten', language: string, style: string): string => {
  const shared = `- 语言：${language === 'en' ? '英文' : '简体中文'}\n- 不要写主题行，不要输出 Markdown 标记，不要解释你在做什么\n- 只输出正文本身`
  const styleLine = style === '' ? '' : `\n写作风格（模仿但不生硬）：\n${style}`
  if (mode === 'polish') {
    return `你是邮件写作助理。润色用户给出的邮件正文，保持原意和事实，让表达更清晰自然。\n\n要求：\n${shared}${styleLine}`
  }
  if (mode === 'shorten') {
    return `你是邮件写作助理。把用户给出的邮件正文缩短到约一半，保留关键信息和事实。\n\n要求：\n${shared}${styleLine}`
  }
  return `你是邮件写作助理。根据用户给出的要点写一封邮件正文。\n\n要求：\n${shared}${styleLine}`
}

const TASK_SYSTEM = `你是任务提取助手。从邮件中提取需要用户处理的具体事项。

只输出一个 JSON 数组，不要输出解释、Markdown 或代码块标记。每个元素：
{"title": "任务标题（动词开头，尽量具体）", "due": "YYYY-MM-DD 或空字符串", "priority": 0 到 9 的整数, "owner": "负责人或空字符串", "notes": "一句来源依据"}

规则：
- 只提取邮件里明确要求、或明显需要跟进的事项
- 截止时间能确定才填，否则留空
- 没有可执行事项时输出 []
- 不要编造邮件里没有的信息`

const STYLE_SYSTEM = `你是写作风格分析师。阅读用户最近发出的邮件，用简体中文写一段 150-300 字的写作风格档案，覆盖：
常用称呼、开头方式、结尾与署名、语气（正式/亲切/直接）、句子长短、常用表达或口头禅。
只输出档案正文，不要输出标题、列表符号或分析过程。`

function stylePath(root: string): string {
  return join(root, 'style.json')
}

function readStyle(root: string): StyleProfile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stylePath(root), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const value = parsed as Partial<StyleProfile>
    if (typeof value.profile !== 'string' || value.profile.trim() === '') return null
    return {
      profile: value.profile,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      sampleCount: typeof value.sampleCount === 'number' ? value.sampleCount : 0,
    }
  } catch {
    return null
  }
}

function writeStyle(root: string, profile: StyleProfile): void {
  const file = stylePath(root)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

function clip(value: string, max = MAX_PROMPT_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max - 2000)}\n…（中间省略）…\n${value.slice(-2000)}`
}

/** Plain-text body of a mail message, falling back from HTML. */
function bodyText(message: MessageDetail): string {
  if (message.text.trim() !== '') return message.text
  return (message.html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

function contextOf(message: MessageDetail): string {
  const lines = [
    `主题: ${message.subject}`,
    `发件人: ${message.from.name !== '' ? `${message.from.name} <${message.from.address}>` : message.from.address}`,
    `收件人: ${message.to.map((item) => (item.name !== '' ? `${item.name} <${item.address}>` : item.address)).join(', ')}`,
    ...(message.cc.length === 0 ? [] : [`抄送: ${message.cc.map((item) => item.address).join(', ')}`]),
    `时间: ${message.date}`,
    '',
    clip(bodyText(message)),
  ]
  return lines.join('\n')
}

/**
 * Reading and writing assistance backed by the Host's model service.
 *
 * The service never sends mail: it only produces text for the panel, and every
 * send still needs the user's click. Nothing is sent to the model when AI is
 * disabled or the composition has no model service.
 */
export class AiService {
  private readonly deps: AiDeps

  constructor(deps: AiDeps) {
    this.deps = deps
  }

  private llm(): DshLlm | undefined {
    try {
      return this.deps.llm()
    } catch {
      return undefined
    }
  }

  status(account: Account | null): AiStatus {
    const config = this.deps.config()
    const llm = this.llm()
    const style = account === null ? null : this.style(account)
    return {
      available: llm !== undefined,
      enabled: config.ai.enabled,
      provider: config.ai.provider,
      model: config.ai.model,
      styleUpdatedAt: style?.updatedAt ?? '',
      styleSampleCount: style?.sampleCount ?? 0,
      ...(llm === undefined ? { error: '当前 DSH 组合没有可用的模型服务' } : {}),
    }
  }

  style(account: Account): StyleProfile | null {
    return readStyle(this.deps.accountRoot(account))
  }

  saveStyle(account: Account, profile: string): StyleProfile {
    const text = profile.trim()
    if (text === '') throw new Error('写作风格不能为空')
    if (text.length > 8000) throw new Error('写作风格过长（最多 8000 字）')
    const previous = this.style(account)
    const next: StyleProfile = {
      profile: text,
      updatedAt: new Date().toISOString(),
      sampleCount: previous?.sampleCount ?? 0,
    }
    writeStyle(this.deps.accountRoot(account), next)
    return next
  }

  private requireReady(): { provider: string; model: string } {
    const config = this.deps.config()
    if (!config.ai.enabled) throw new Error('AI 功能已关闭，请到设置里开启')
    const llm = this.llm()
    if (llm === undefined) throw new Error('当前 DSH 组合没有可用的模型服务')
    if (config.ai.provider === '' || config.ai.model === '') throw new Error('请先在设置里选择 AI 模型')
    return { provider: config.ai.provider, model: config.ai.model }
  }

  private async complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
    const { provider, model } = this.requireReady()
    const llm = this.llm()
    if (llm === undefined) throw new Error('当前 DSH 组合没有可用的模型服务')
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, TIMEOUT_MS)
    const onAbort = (): void => {
      controller.abort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let text = ''
    try {
      const stream = llm.stream({
        provider,
        model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: system }] },
          { role: 'user', content: [{ type: 'text', text: user }] },
        ],
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason?.kind === 'error') {
            throw new Error(reason.failure?.message ?? reason.failure?.code ?? '模型调用失败')
          }
          if (reason?.kind === 'aborted') throw new Error('模型调用已取消')
        }
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const trimmed = text.trim()
    if (trimmed === '') throw new Error('模型没有返回内容')
    return trimmed
  }

  async summarize(message: MessageDetail, signal?: AbortSignal): Promise<string> {
    return this.complete(SUMMARY_SYSTEM, contextOf(message), signal)
  }

  async reply(
    account: Account,
    message: MessageDetail,
    options: { instruction?: string; language?: 'zh' | 'en' } = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const style = this.style(account)?.profile ?? ''
    const instruction = (options.instruction ?? '').trim()
    const user = [
      '原始邮件：',
      contextOf(message),
      '',
      instruction === '' ? '用户没有额外要求，请写一封得体的回复。' : `用户的要求：${instruction}`,
    ].join('\n')
    return this.complete(REPLY_SYSTEM(options.language ?? 'zh', style), user, signal)
  }

  async translate(html: string, target: 'zh' | 'en', signal?: AbortSignal): Promise<string> {
    const text = html.trim()
    if (text === '') throw new Error('正文为空，无法翻译')
    return this.complete(TRANSLATE_SYSTEM(target), clip(text, 20_000), signal)
  }

  /** Free-form question about a mail, with up to three earlier AI outputs as context. */
  async ask(
    message: MessageDetail,
    question: string,
    history: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = (question ?? '').trim()
    if (prompt === '') throw new Error('问题不能为空')
    const earlier = history
      .filter((item) => item.trim() !== '')
      .slice(-3)
      .map((item, index) => `【已有记录 ${String(index + 1)}】\n${clip(item, 4000)}`)
      .join('\n\n')
    const user = [
      '邮件：',
      contextOf(message),
      ...(earlier === '' ? [] : ['', '已有 AI 记录：', earlier]),
      '',
      `用户的问题：${prompt}`,
    ].join('\n')
    return this.complete(ASK_SYSTEM, user, signal)
  }

  /** Extract actionable tasks from one mail. */
  async extractTasks(message: MessageDetail, signal?: AbortSignal): Promise<TaskSuggestion[]> {
    const text = await this.complete(TASK_SYSTEM, contextOf(message), signal)
    return parseTaskJson(text)
  }

  /** Compose-body assistance: draft from points, polish, or shorten. */
  async compose(
    account: Account,
    options: {
      mode: 'draft' | 'polish' | 'shorten'
      instruction?: string
      html: string
      language?: 'zh' | 'en'
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const style = this.style(account)?.profile ?? ''
    const language = options.language ?? 'zh'
    const body = options.html.trim()
    if (options.mode !== 'draft' && body === '') throw new Error('正文为空')
    const source =
      options.mode === 'draft'
        ? `用户要点：${(options.instruction ?? '').trim() === '' ? '写一封简短的邮件' : (options.instruction ?? '').trim()}`
        : `需要处理的正文：\n${clip(htmlToPlain(body), 12000)}`
    return this.complete(COMPOSE_SYSTEM(options.mode, language, style), source, signal)
  }

  async learnStyle(
    account: Account,
    samples: { subject: string; text: string }[],
    signal?: AbortSignal,
  ): Promise<StyleProfile> {
    if (samples.length === 0) throw new Error('没有可用的已发送邮件，先备份一次邮箱')
    const digest = samples
      .slice(0, 100)
      .map((sample, index) => `【${String(index + 1)}】主题：${sample.subject}\n${clip(sample.text, 800)}`)
      .join('\n\n')
    const profile = await this.complete(STYLE_SYSTEM, clip(digest, 35_000), signal)
    const next: StyleProfile = {
      profile,
      updatedAt: new Date().toISOString(),
      sampleCount: samples.length,
    }
    writeStyle(this.deps.accountRoot(account), next)
    return next
  }

  async models(): Promise<{ provider: string; name: string; models: { id: string; name: string }[] }[]> {
    const llm = this.llm()
    if (llm === undefined) return []
    const providers = llm.listProviders()
    const catalog: { provider: string; name: string; models: { id: string; name: string }[] }[] = []
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id)
        catalog.push({
          provider: provider.id,
          name: provider.name ?? provider.id,
          models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
        })
      } catch {
        catalog.push({ provider: provider.id, name: provider.name ?? provider.id, models: [] })
      }
    }
    return catalog
  }
}

/**
 * The model may answer a translation with a complete HTML document. Keep the
 * body for insertion, and derive plain text for display so the panel never
 * shows raw tags.
 */
export function normalizeTranslated(value: string): { text: string; html: string } {
  const raw = value.trim()
  if (raw === '') return { text: '', html: '' }
  if (!/<[a-z][\s\S]*>/i.test(raw)) return { text: raw, html: textToHtml(raw) }
  let body = raw
  const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw)
  if (match !== null) body = match[1] ?? ''
  body = body
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .trim()
  const text = htmlToPlain(body)
  if (body === '' || text === '') return { text: raw, html: textToHtml(raw) }
  return { text, html: body }
}

/** Strip HTML tags for prompts that must receive plain text. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface TaskSuggestion {
  title: string
  due: string
  priority: number
  owner: string
  notes: string
}

/** Parse the model's JSON array, tolerating code fences and prose around it. */
export function parseTaskJson(text: string): TaskSuggestion[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const result: TaskSuggestion[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    const title = String(value.title ?? '').trim()
    if (title === '') continue
    result.push({
      title: title.slice(0, 300),
      due: /^\d{4}-\d{2}-\d{2}/.test(String(value.due ?? '')) ? String(value.due).slice(0, 10) : '',
      priority: Math.max(0, Math.min(9, Number(value.priority ?? 0) || 0)),
      owner: String(value.owner ?? '').slice(0, 120),
      notes: String(value.notes ?? '').slice(0, 1000),
    })
  }
  return result.slice(0, 30)
}

/** Markdown-ish summary → simple blocks for the panel. */
export function summaryBlocks(text: string): { title: string; body: string }[] {
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

export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${paragraph.trim().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('\n', '<br>')}</p>`,
    )
    .join('')
}

export { existsSync }
