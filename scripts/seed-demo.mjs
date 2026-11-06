#!/usr/bin/env node
/**
 * Build a disposable MailHarbor data root with fabricated mail, for README
 * screenshots and manual UI checks. Never point this at a real data directory.
 *
 *   node scripts/seed-demo.mjs [dir]
 *   DSH_MAILHARBOR_DATA_DIR="$PWD/.demo-data" dsh --profile web --no-open
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(process.argv[2] ?? '.demo-data')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT, mailbox TEXT NOT NULL, uid INTEGER,
    subject TEXT, from_name TEXT, from_addr TEXT, to_addr TEXT, cc TEXT, date TEXT,
    message_id TEXT UNIQUE, body_text TEXT, body_html TEXT, raw_eml BLOB, hash TEXT,
    backup_log_id INTEGER, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email_id INTEGER NOT NULL,
    filename TEXT NOT NULL, content_type TEXT, size INTEGER, data BLOB, hash TEXT
  );
  CREATE TABLE IF NOT EXISTS backup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, completed_at TEXT,
    mailboxes TEXT, new_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0,
    total_emails INTEGER DEFAULT 0, cumulative_hash TEXT, status TEXT DEFAULT 'running', error_info TEXT
  );
  CREATE TABLE IF NOT EXISTS backup_state (mailbox TEXT PRIMARY KEY, uid_validity TEXT, last_uid INTEGER, updated_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_emails_mailbox_date ON emails(mailbox, date);
  CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
`

const accounts = [
  {
    id: 'acc_demo_work',
    label: '工作邮箱',
    email: 'lin@example.com',
    fromName: '林工',
    folder: 'INBOX',
    messages: [
      {
        subject: '关于“星港”项目二期报价的确认',
        from: '王敏 <wang.min@example.com>',
        date: '2026-11-06 09:12:00',
        text: '林工您好：\n\n附件是“星港”项目二期的报价单，请在本周五前确认。若有疑问随时联系。\n\n谢谢！',
        html: '<p>林工您好：</p><p>附件是“星港”项目二期的报价单，请在本周五前确认。若有疑问随时联系。</p><p>谢谢！</p>',
        attachment: { name: '星港二期报价单.xlsx', type: 'application/vnd.ms-excel', size: 48213 },
        unread: true,
      },
      {
        subject: 'Re: 设备到货验收安排',
        from: '陈立 <chen.li@example.com>',
        date: '2026-11-05 16:40:00',
        text: '林工，设备已到仓库，验收定在周四上午十点，麻烦安排同事参加。',
        html: '<p>林工，设备已到仓库，验收定在周四上午十点，麻烦安排同事参加。</p>',
        unread: true,
      },
      {
        subject: '11 月部门例会材料',
        from: '张倩 <zhang.qian@example.com>',
        date: '2026-11-05 10:05:00',
        text: '各位好，11 月例会定在下周一，请把各自模块的进度更新到共享文档。',
        html: '<p>各位好，11 月例会定在下周一，请把各自模块的进度更新到共享文档。</p>',
        unread: false,
      },
      {
        subject: 'Visa renewal documents — Lin Zhixin',
        from: 'HR Shared Services <hr@example.com>',
        date: '2026-11-04 14:22:00',
        text: 'Dear Lin,\n\nPlease find attached the documents for your visa renewal. Sign and return by 15 November.\n\nBest regards,\nHR Shared Services',
        html: '<p>Dear Lin,</p><p>Please find attached the documents for your visa renewal. Sign and return by 15 November.</p><p>Best regards,<br>HR Shared Services</p>',
        unread: false,
      },
      {
        subject: '服务器维护窗口通知',
        from: 'IT Operations <it-ops@example.com>',
        date: '2026-11-03 18:00:00',
        text: '本周日 02:00–04:00 进行存储维护，期间内部系统可能短暂不可用。',
        html: '<p>本周日 02:00–04:00 进行存储维护，期间内部系统可能短暂不可用。</p>',
        unread: false,
      },
      {
        subject: 'Quote for sampling probes',
        from: 'Noman Aslam <noman@example.com>',
        date: '2026-11-03 09:30:00',
        text: 'Dear Lin,\n\nPlease find our quotation for the sampling probes. Lead time is 6 weeks.\n\nRegards,\nNoman',
        html: '<p>Dear Lin,</p><p>Please find our quotation for the sampling probes. Lead time is 6 weeks.</p><p>Regards,<br>Noman</p>',
        unread: false,
      },
    ],
  },
  {
    id: 'acc_demo_team',
    label: '团队邮箱',
    email: 'team@example.org',
    fromName: '项目组',
    folder: 'INBOX',
    messages: [
      {
        subject: '【周报】第 45 周项目进展',
        from: '项目助理 <assistant@example.org>',
        date: '2026-11-06 08:05:00',
        text: '本周完成：接口联调、验收材料初稿。\n下周计划：现场验收、问题闭环。\n风险：备件到货时间。',
        html: '<p><strong>本周完成：</strong>接口联调、验收材料初稿。</p><p><strong>下周计划：</strong>现场验收、问题闭环。</p><p><strong>风险：</strong>备件到货时间。</p>',
        unread: true,
      },
      {
        subject: '周五团建报名',
        from: '工会 <club@example.org>',
        date: '2026-11-04 12:00:00',
        text: '本周五下午团建，请在周三前回复是否参加。',
        html: '<p>本周五下午团建，请在周三前回复是否参加。</p>',
        unread: false,
      },
    ],
  },
]

let messageId = 100
for (const account of accounts) {
  const dir = join(root, 'accounts', account.id)
  mkdirSync(join(dir, 'attachments'), { recursive: true })
  const db = new DatabaseSync(join(dir, 'mail.db'))
  db.exec(SCHEMA)
  const insert = db.prepare(
    `INSERT INTO emails (mailbox, uid, subject, from_name, from_addr, to_addr, cc, date, message_id, body_text, body_html)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
  )
  const attach = db.prepare(
    'INSERT INTO attachments (email_id, filename, content_type, size, hash) VALUES (?, ?, ?, ?, ?)',
  )
  let uid = 1
  for (const message of account.messages) {
    const match = /^(.*?)\s*<([^>]+)>$/.exec(message.from)
    const name = match === null ? '' : (match[1] ?? '').trim()
    const addressText = match === null ? message.from : (match[2] ?? '')
    const result = insert.run(
      account.folder,
      uid,
      message.subject,
      name,
      addressText,
      `${account.fromName} <${account.email}>`,
      message.date,
      `demo-${String(messageId++).padStart(4, '0')}@example.com`,
      message.text,
      message.html,
    )
    if (message.attachment !== undefined) {
      const file = message.attachment
      const hash = `demo${String(result.lastInsertRowid).padStart(4, '0')}`
      attach.run(Number(result.lastInsertRowid), file.name, file.type, file.size, hash)
      mkdirSync(join(dir, 'attachments', hash.slice(0, 2), hash.slice(2, 4)), { recursive: true })
      writeFileSync(
        join(dir, 'attachments', hash.slice(0, 2), hash.slice(2, 4), hash),
        `demo attachment ${file.name}`,
      )
    }
    uid += 1
  }
  // A couple of sent messages so the style feature has samples.
  const sent = db.prepare(
    `INSERT INTO emails (mailbox, uid, subject, from_name, from_addr, to_addr, cc, date, message_id, body_text, body_html)
     VALUES ('Sent Items', ?, ?, ?, ?, ?, '', ?, ?, ?, '')`,
  )
  for (let index = 1; index <= 6; index += 1) {
    sent.run(
      index,
      `Re: 项目进度确认 ${String(index)}`,
      account.fromName,
      account.email,
      `wang.min@example.com`,
      `2026-10-2${String(index)} 10:00:00`,
      `demo-sent-${account.id}-${String(index)}@example.com`,
      `王工您好：\n\n已收到，我们按计划推进，本周五前给答复。\n\n谢谢！\n${account.fromName}`,
    )
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
    subject, from_name, from_addr, to_addr, cc, body_text, att_filename, content='', tokenize='trigram'
  )`)
  db.exec(`INSERT INTO emails_fts (rowid, subject, from_name, from_addr, to_addr, cc, body_text, att_filename)
           SELECT id, subject, from_name, from_addr, to_addr, cc, body_text, '' FROM emails`)
  db.close()
  writeFileSync(join(dir, 'read-state.json'), `${JSON.stringify({ unread: [] }, null, 2)}\n`)
  writeFileSync(
    join(dir, 'style.json'),
    `${JSON.stringify(
      {
        profile:
          '称呼多用「姓+工」或「X 总」，先称呼再直入事项；结尾常用「谢谢！」并署名。语气正式、礼貌、务实，句子偏短，重要信息用条目列出。',
        updatedAt: '2026-11-06T10:00:00.000Z',
        sampleCount: 6,
      },
      null,
      2,
    )}\n`,
  )
}

writeFileSync(
  join(root, 'config.json'),
  `${JSON.stringify(
    {
      accounts: accounts.map((account) => ({
        id: account.id,
        label: account.label,
        email: account.email,
        username: account.email,
        imap: { host: 'imap.example.com', port: 993, secure: true },
        smtp: { host: 'smtp.example.com', port: 465, secure: true, fromName: account.fromName },
        keychainService: `demo:${account.id}`,
        dataDir: `accounts/${account.id}`,
        auth: { type: 'password' },
        caldav: null,
        enabled: true,
        createdAt: '2026-11-01T00:00:00.000Z',
      })),
      activeAccountId: 'acc_demo_work',
      signature: '此致\n林工',
    },
    null,
    2,
  )}\n`,
)

console.log(`demo data ready at ${root}`)
console.log(`try: DSH_MAILHARBOR_DATA_DIR="${root}" dsh --profile web --no-open`)
console.log(`fabricated mail only — do not merge with a real data directory`)
