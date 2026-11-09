import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AiService,
  normalizeTranslated,
  stripReplySuggestions,
  summaryBlocks,
  textToHtml,
} from '../src/host/ai.js'
import type { MailHarborConfig } from '../src/host/config.js'
import type { DshLlm, DshLlmChunk } from '../src/host/dsh.js'
import type { Account, MessageDetail } from '../src/shared/types.js'

function config(overrides: Partial<MailHarborConfig['ai']> = {}): MailHarborConfig {
  return {
    dataDir: '/tmp',
    configFile: '/tmp/config.json',
    accounts: [],
    activeAccountId: null,
    signature: '',
    ai: {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-flash',
      styleSampleCount: 100,
      maxChars: 40000,
      ...overrides,
    },
    read: { markOnOpen: true, pollSeconds: 60 },
    render: { listLimit: 40 },
    projects: { root: '/tmp/projects' },
    oauth: {
      google: { clientId: '', redirectPort: 8765, scopes: [] },
      microsoft: { clientId: '', scopes: [] },
    },
    revision: 1,
  }
}

const account: Account = {
  id: 'acc_1',
  label: 'Test',
  email: 'me@example.com',
  username: 'me@example.com',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true, fromName: '' },
  keychainService: 'x',
  dataDir: '/tmp',
  auth: { type: 'password' },
  caldav: null,
  enabled: true,
  createdAt: '2026-11-06T00:00:00.000Z',
}

const message: MessageDetail = {
  id: '1',
  accountId: account.id,
  uid: 1,
  messageId: 'm1@example.com',
  subject: '季度预算复核',
  from: { name: 'Alice', address: 'alice@example.com' },
  to: [{ name: '', address: 'me@example.com' }],
  cc: [],
  replyTo: [],
  date: '2026-11-06T09:00:00.000Z',
  unread: true,
  flagged: false,
  hasAttachments: false,
  snippet: '',
  mailbox: 'INBOX',
  text: '请在周五前复核预算表。',
  html: null,
  attachments: [],
  references: [],
}

function fakeLlm(reply = '这是模型的回答'): { llm: DshLlm; prompts: { system: string; user: string }[] } {
  const prompts: { system: string; user: string }[] = []
  const llm: DshLlm = {
    async *stream(options): AsyncIterable<DshLlmChunk> {
      prompts.push({
        system: String(options.messages[0]?.content[0]?.text ?? ''),
        user: String(options.messages[1]?.content[0]?.text ?? ''),
      })
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'ok' } }
    },
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'Flash' }],
  }
  return { llm, prompts }
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailharbor-ai-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AiService', () => {
  it('summarizes in Chinese and sends the mail context', async () => {
    const { llm, prompts } = fakeLlm('## 结论\n需要复核预算。')
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    const summary = await service.summarize(message)
    expect(summary).toContain('需要复核预算')
    expect(prompts[0]?.system).toContain('简体中文')
    expect(prompts[0]?.user).toContain('季度预算复核')
    expect(prompts[0]?.user).toContain('请在周五前复核预算表')
  })

  it('marks a cc-only recipient and skips reply suggestions in the prompt', async () => {
    const ccMessage = {
      ...message,
      to: [{ name: '', address: 'bob@example.com' }],
      cc: [{ name: '', address: 'me@example.com' }],
    }
    const { llm, prompts } = fakeLlm('## 结论\n只是知悉。')
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    await service.summarize(ccMessage, account.email)
    expect(prompts[0]?.user).toContain('你的身份: 仅抄送')
    expect(prompts[0]?.system).toContain('不要输出「建议回复要点」')
  })

  it('drops reply suggestions for a cc-only summary', async () => {
    const ccMessage = {
      ...message,
      to: [{ name: '', address: 'bob@example.com' }],
      cc: [{ name: '', address: 'me@example.com' }],
    }
    const { llm } = fakeLlm('## 结论\n知悉即可。\n\n## 建议回复要点\n- 已收到')
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    const summary = await service.summarize(ccMessage, account.email)
    expect(summary).toContain('知悉即可')
    expect(summary).not.toContain('建议回复要点')
    expect(stripReplySuggestions('A\n建议回复要点\n- x')).toBe('A')
  })

  it('marks a direct recipient in the prompt', async () => {
    const { llm, prompts } = fakeLlm('## 结论\n需要复核。')
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    await service.summarize(message, account.email)
    expect(prompts[0]?.user).toContain('你的身份: 直接收件人')
  })

  it('includes the saved writing style in a reply prompt', async () => {
    const { llm, prompts } = fakeLlm('收到，周五前给答复。')
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    service.saveStyle(account, '开头用「您好」，结尾用「谢谢」，语气简洁。')
    const text = await service.reply(account, message, { instruction: '确认收到', language: 'zh' })
    expect(text).toContain('周五前')
    expect(prompts[0]?.system).toContain('开头用「您好」')
    expect(prompts[0]?.user).toContain('确认收到')
    expect(prompts[0]?.system).toContain('简体中文')
  })

  it('asks for English when translating to en', async () => {
    const { llm, prompts } = fakeLlm('Please review the budget.')
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    const result = await service.translate('<p>请在周五前复核预算表。</p>', 'en')
    expect(result).toContain('budget')
    expect(prompts[0]?.system).toContain('英文')
  })

  it('learns and persists a style profile from sent samples', async () => {
    const { llm } = fakeLlm('该用户称呼对方为「王工」，结尾使用「谢谢」，句子简短。')
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    const style = await service.learnStyle(account, [
      { subject: '回复：报价', text: '王工您好，报价已收到。谢谢。' },
      { subject: '回复：排期', text: '王工您好，排期确认。谢谢。' },
    ])
    expect(style.sampleCount).toBe(2)
    expect(service.style(account)?.profile).toContain('王工')
  })

  it('rejects when AI is disabled or the model service is missing', async () => {
    const { llm } = fakeLlm()
    const disabled = new AiService({
      config: () => config({ enabled: false }),
      llm: () => llm,
      accountRoot: () => dir,
    })
    await expect(disabled.summarize(message)).rejects.toThrow('AI 功能已关闭')

    const missing = new AiService({ config: () => config(), llm: () => undefined, accountRoot: () => dir })
    await expect(missing.summarize(message)).rejects.toThrow('没有可用的模型服务')
    expect(missing.status(account).available).toBe(false)
  })

  it('lists providers and models', async () => {
    const { llm } = fakeLlm()
    const service = new AiService({ config: () => config(), llm: () => llm, accountRoot: () => dir })
    expect(await service.models()).toEqual([
      { provider: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ])
  })
})

describe('AI output helpers', () => {
  it('normalizes a translated HTML document for display and insertion', () => {
    const result = normalizeTranslated(
      '<!doctype html><html><head><style>p{}</style></head><body><p>Hello <b>there</b></p></body></html>',
    )
    expect(result.text).toBe('Hello there')
    expect(result.html).toBe('<p>Hello <b>there</b></p>')

    expect(normalizeTranslated('Hola')).toEqual({ text: 'Hola', html: '<p>Hola</p>' })
  })

  it('splits a summary into titled blocks', () => {
    const blocks = summaryBlocks('结论\n需要复核。\n\n需要你做什么\n- 周五前确认')
    expect(blocks).toEqual([
      { title: '结论', body: '需要复核。' },
      { title: '需要你做什么', body: '- 周五前确认' },
    ])
  })

  it('converts reply text into paragraphs', () => {
    expect(textToHtml('第一段\n\n第二段')).toBe('<p>第一段</p><p>第二段</p>')
  })
})
