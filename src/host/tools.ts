import type { MessageDetail, MessageSummary } from '../shared/types.js'
import { formatAddressList } from './address.js'
import type { DshToolDefinition, DshTools } from './dsh.js'
import type { MailHarborRuntime } from './runtime.js'
import type { Account } from '../shared/types.js'

const MAX_BODY = 20_000
const MAX_LIST = 50

function textOf(args: unknown, key: string): string {
  if (args === null || typeof args !== 'object') return ''
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function numberOf(args: unknown, key: string): number | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clip(text: string, max = MAX_BODY): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

function line(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stamp(value: string): string {
  return value.slice(0, 19).replace('T', ' ')
}

function addressText(list: { name: string; address: string }[]): string {
  return formatAddressList(list)
}

function summaryLine(item: MessageSummary, index: number): string {
  const flags = [
    item.backedUp === false ? '未备份' : item.backedUp === true ? '已备份' : '',
    item.hasAttachments ? '有附件' : '',
    item.unread ? '未读' : '',
  ].filter(Boolean)
  return `${String(index + 1)}. [id=${item.id}] ${stamp(item.date)} · ${line(item.from.name || item.from.address)} · ${line(item.subject)}${flags.length === 0 ? '' : ` · ${flags.join(' · ')}`}\n   ${item.snippet}`
}

function detailText(message: MessageDetail): string {
  const head = [
    `${message.backedUp === true ? '已备份' : '服务器实时'}`,
    `主题: ${line(message.subject)}`,
    `发件人: ${line(message.from.name)} <${message.from.address}>`,
    `收件人: ${line(addressText(message.to))}`,
    ...(message.cc.length === 0 ? [] : [`抄送: ${line(addressText(message.cc))}`]),
    `时间: ${stamp(message.date)}`,
    ...(message.attachments.length === 0
      ? []
      : [
          `附件: ${message.attachments.map((file) => `${file.filename}(${String(file.size)} B)`).join('、')}`,
        ]),
    '',
    clip(message.text !== '' ? message.text : '(无正文)'),
  ]
  return head.join('\n')
}

function plainSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

function textResult(
  _label: string,
  schema: Record<string, unknown> = { type: 'string' },
): DshToolDefinition['output'] {
  return {
    schema,
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
    ],
  }
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  output: DshToolDefinition['output'],
  execute: (args: unknown) => Promise<unknown>,
): DshToolDefinition {
  return {
    name,
    description,
    parameters,
    output,
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: name, kind: 'read', rawInput: args }),
    execute: async (args: unknown) => execute(args),
  }
}

/**
 * Register the `mail_*` tools. The model can read mail, search the local
 * backup, and manage drafts; sending stays a user action in the panel, so no
 * tool can put a message on the wire without the user pressing send.
 */
export function registerMailTools(tools: DshTools, runtime: MailHarborRuntime): (() => void)[] {
  const activeAccount = (): Account => {
    const account = runtime.active()
    if (account === null) throw new Error('请先在 MailHarbor 面板里添加一个邮箱账号')
    return account
  }

  const definitions: DshToolDefinition[] = [
    tool(
      'mail_status',
      '查看邮箱状态：账号、是否已登录、本地备份邮件数、上次备份时间。只读，不修改任何内容。',
      plainSchema({}),
      textResult('状态', {
        type: 'object',
        properties: {
          account: { type: 'string' },
          loggedIn: { type: 'boolean' },
          localTotal: { type: 'number' },
          lastBackup: { type: 'string' },
          backupRunning: { type: 'boolean' },
        },
        required: ['account', 'loggedIn', 'localTotal'],
      }),
      async () => {
        const account = activeAccount()
        const status = runtime.database(account).status()
        const backup = runtime.backupStatus(account)
        return {
          account: account.email,
          loggedIn: runtime.hasCredentials(account),
          localTotal: status.total,
          lastBackup: backup.lastSuccessAt ?? '',
          backupRunning: backup.running,
        }
      },
    ),
    tool(
      'mail_list',
      '列出本地备份或服务器上的邮件摘要。source=local 读本地备份（快、可搜索），source=server 读服务器实时。',
      plainSchema({
        source: { type: 'string', enum: ['local', 'server'], description: '默认 local' },
        mailbox: { type: 'string', description: '邮箱文件夹路径，默认 all（本地）或 INBOX（服务器）' },
        query: { type: 'string', description: '关键词，仅本地搜索' },
        limit: { type: 'number', description: '最多返回多少封，默认 20，最大 50' },
      }),
      textResult('邮件列表', {
        type: 'object',
        properties: {
          source: { type: 'string' },
          total: { type: 'number' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                subject: { type: 'string' },
                from: { type: 'string' },
                date: { type: 'string' },
                unread: { type: 'boolean' },
                backedUp: { type: 'boolean' },
              },
              required: ['id', 'subject', 'from', 'date', 'unread', 'backedUp'],
            },
          },
          text: { type: 'string' },
        },
        required: ['source', 'total', 'items', 'text'],
      }),
      async (args) => {
        const account = activeAccount()
        const source = textOf(args, 'source') === 'server' ? 'server' : 'local'
        const mailbox =
          textOf(args, 'mailbox') !== '' ? textOf(args, 'mailbox') : source === 'server' ? 'INBOX' : 'all'
        const limit = Math.min(MAX_LIST, Math.max(1, numberOf(args, 'limit') ?? 20))
        const query = textOf(args, 'query')
        let items: MessageSummary[] = []
        let total = 0
        if (source === 'server') {
          const provider = runtime.provider(account)
          const result = await provider.list(mailbox, limit)
          total = result.total
          const db = runtime.database(account)
          items = result.items.map((message) => ({
            id: String(message.uid),
            accountId: account.id,
            uid: message.uid,
            messageId: message.messageId,
            subject: message.subject,
            from: message.from,
            to: message.to,
            date: message.date,
            unread: !message.read,
            flagged: false,
            hasAttachments: false,
            snippet: '',
            mailbox,
            backedUp: message.messageId !== '' && db.hasMessageId(message.messageId),
          }))
        } else {
          const page = runtime.database(account).list({
            mailbox,
            query,
            limit,
            offset: 0,
          })
          total = page.total
          const readState = runtime.readState(account)
          items = page.items.map((item) => ({
            ...item,
            accountId: account.id,
            unread:
              item.messageId !== undefined && item.messageId !== ''
                ? readState.isUnread(`mid:${item.messageId}`)
                : readState.isUnread(`local:${item.id}`),
            backedUp: true,
          }))
        }
        const head = `${source === 'server' ? '服务器实时' : '本地备份'} · ${mailbox} · ${String(items.length)}/${String(total)} 封`
        return {
          source,
          total,
          items: items.map((item) => ({
            id: item.id,
            subject: item.subject,
            from: item.from.name || item.from.address,
            date: stamp(item.date),
            unread: item.unread,
            backedUp: item.backedUp ?? true,
          })),
          text:
            items.length === 0 ? `${head}\n（没有邮件）` : `${head}\n\n${items.map(summaryLine).join('\n')}`,
        }
      },
    ),
    tool(
      'mail_read',
      '读取一封邮件的全文。本地备份用 id；服务器邮件用 uid 并传 source=server、mailbox。',
      plainSchema(
        {
          id: { type: 'string', description: '本地邮件 id 或服务器 uid' },
          source: { type: 'string', enum: ['local', 'server'], description: '默认 local' },
          mailbox: { type: 'string', description: '服务器文件夹路径，默认 INBOX' },
        },
        ['id'],
      ),
      textResult('邮件全文', {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          from: { type: 'string' },
          date: { type: 'string' },
          text: { type: 'string' },
          attachments: { type: 'array', items: { type: 'object' } },
        },
        required: ['subject', 'from', 'date', 'text', 'attachments'],
      }),
      async (args) => {
        const account = activeAccount()
        const id = textOf(args, 'id')
        if (id === '') throw new Error('缺少邮件 id')
        const source = textOf(args, 'source') === 'server' ? 'server' : 'local'
        if (source === 'server') {
          const mailbox = textOf(args, 'mailbox') !== '' ? textOf(args, 'mailbox') : 'INBOX'
          const message = await runtime.provider(account).read(mailbox, Number(id))
          const detail = {
            ...message,
            id: String(message.uid),
            accountId: account.id,
            cc: message.cc,
            replyTo: [],
            unread: !message.read,
            flagged: false,
            hasAttachments: message.attachments.length > 0,
            snippet: '',
            mailbox,
            backedUp: message.messageId !== '' && runtime.database(account).hasMessageId(message.messageId),
          } as MessageDetail
          return {
            subject: detail.subject,
            from: `${detail.from.name} <${detail.from.address}>`.trim(),
            date: stamp(detail.date),
            text: clip(detail.text),
            attachments: detail.attachments.map((file) => ({
              filename: file.filename,
              contentType: file.contentType,
              size: file.size,
            })),
          }
        }
        const detail = runtime.database(account).get(Number(id))
        if (detail === undefined) throw new Error('邮件不存在')
        return {
          subject: detail.subject,
          from: `${detail.from.name} <${detail.from.address}>`.trim(),
          date: stamp(detail.date),
          text: clip(detail.text),
          attachments: detail.attachments.map((file) => ({
            filename: file.filename,
            contentType: file.contentType,
            size: file.size,
          })),
        }
      },
    ),
    tool(
      'mail_search',
      '在本地备份中全文搜索（主题、发件人、收件人、正文、附件名）。只读。',
      plainSchema(
        {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '最多返回多少封，默认 20' },
        },
        ['query'],
      ),
      textResult('搜索结果'),
      async (args) => {
        const account = activeAccount()
        const query = textOf(args, 'query')
        if (query === '') throw new Error('缺少搜索关键词')
        const limit = Math.min(MAX_LIST, Math.max(1, numberOf(args, 'limit') ?? 20))
        const page = runtime.database(account).list({ mailbox: 'all', query, limit, offset: 0 })
        const readState = runtime.readState(account)
        return page.items.length === 0
          ? `没有匹配「${query}」的邮件`
          : `搜索「${query}」：${String(page.total)} 封中前 ${String(page.items.length)} 封\n\n${page.items
              .map((item, index) =>
                summaryLine(
                  {
                    ...item,
                    accountId: account.id,
                    unread: readState.isUnread(`local:${item.id}`),
                    backedUp: true,
                  },
                  index,
                ),
              )
              .join('\n')}`
      },
    ),
    tool(
      'mail_drafts',
      '列出当前账号的草稿。只读，不会发送。',
      plainSchema({}),
      textResult('草稿列表', {
        type: 'object',
        properties: { drafts: { type: 'array', items: { type: 'object' } }, text: { type: 'string' } },
        required: ['drafts', 'text'],
      }),
      async () => {
        const account = activeAccount()
        const drafts = runtime
          .drafts(account)
          .list()
          .map((draft) => ({
            id: draft.id,
            subject: draft.subject,
            to: draft.to,
            updatedAt: draft.updatedAt,
          }))
        return {
          drafts,
          text:
            drafts.length === 0
              ? '（没有草稿）'
              : drafts
                  .map(
                    (draft, index) =>
                      `${String(index + 1)}. [${draft.id}] ${stamp(draft.updatedAt)} · → ${line(draft.to)} · ${line(draft.subject)}`,
                  )
                  .join('\n'),
        }
      },
    ),
    tool(
      'mail_draft',
      '新建或更新一封草稿。只写本地草稿，不会发送；发送仍需用户在面板里确认。',
      plainSchema(
        {
          id: { type: 'string', description: '更新已有草稿时传入' },
          to: { type: 'string' },
          cc: { type: 'string' },
          bcc: { type: 'string' },
          subject: { type: 'string' },
          html: { type: 'string', description: '正文 HTML' },
          inReplyTo: { type: 'string' },
          references: { type: 'string' },
        },
        ['subject'],
      ),
      textResult('草稿', {
        type: 'object',
        properties: { id: { type: 'string' }, subject: { type: 'string' }, updatedAt: { type: 'string' } },
        required: ['id', 'subject', 'updatedAt'],
      }),
      async (args) => {
        const account = activeAccount()
        const draft = runtime.drafts(account).save({
          ...(textOf(args, 'id') !== '' ? { id: textOf(args, 'id') } : {}),
          to: textOf(args, 'to'),
          cc: textOf(args, 'cc'),
          bcc: textOf(args, 'bcc'),
          subject: textOf(args, 'subject'),
          html: textOf(args, 'html'),
          inReplyTo: textOf(args, 'inReplyTo'),
          references: textOf(args, 'references'),
        })
        return { id: draft.id, subject: draft.subject, updatedAt: draft.updatedAt }
      },
    ),
    tool(
      'mail_backup',
      '触发一次增量备份（后台执行）。备份会读取服务器上的全部邮件，可能持续几分钟；只在用户明确要求时调用。',
      plainSchema({}),
      textResult('备份状态', {
        type: 'object',
        properties: { started: { type: 'boolean' }, message: { type: 'string' } },
        required: ['started', 'message'],
      }),
      async () => {
        const account = activeAccount()
        try {
          runtime.startBackup(account)
          return { started: true, message: '备份已在后台开始，进度可在面板的备份弹窗查看' }
        } catch (error) {
          return { started: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    ),
  ]

  return definitions.map((definition) => tools.register(definition))
}

export { detailText }
