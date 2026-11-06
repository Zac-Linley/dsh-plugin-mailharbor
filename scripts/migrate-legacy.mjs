#!/usr/bin/env node
/**
 * Migrate the retired `dsh-plugin-mail` (MailHarbor 0.6.x) data into
 * `@zaclinley/dsh-mailharbor`.
 *
 * The old backup database can be several gigabytes, so the default mode
 * *points* the new account at the existing data directory instead of copying
 * it. `--copy` makes a self-contained copy under the new data root.
 *
 *   node scripts/migrate-legacy.mjs --dry-run
 *   node scripts/migrate-legacy.mjs
 *   node scripts/migrate-legacy.mjs --copy --account me@example.com
 *
 * What it does per account:
 *   - finds (or creates) the account in the new config by email;
 *   - repoints `dataDir` at the old directory (or copies db + attachments);
 *   - converts `read-state.json` keys to the new `mid:` / `local:` form;
 *   - converts old drafts (body/bodyHtml -> html, dataB64 -> data);
 *   - copies the macOS Keychain password to the new service name.
 *
 * The old files are never deleted. A `*.pre-mailharbor` backup is written next
 * to any file it rewrites.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const copy = args.includes('--copy')
const accountFilter = valueOf('--account')?.toLowerCase() ?? ''
const fromRoot = resolve(
  valueOf('--from') ?? process.env.DSH_MAIL_LEGACY_DIR ?? join(homedir(), '.dsh', 'mail-plugin'),
)
const toRoot = resolve(
  valueOf('--to') ?? process.env.DSH_MAILHARBOR_DATA_DIR ?? join(homedir(), '.dsh', 'mailharbor'),
)
const toConfig = process.env.DSH_MAILHARBOR_CONFIG ?? join(toRoot, 'config.json')

function valueOf(flag) {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  return args[index + 1]
}

function log(message) {
  console.log(`${dryRun ? '[dry-run] ' : ''}${message}`)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function backupFile(file) {
  if (!existsSync(file)) return
  const target = `${file}.pre-mailharbor`
  if (existsSync(target)) return
  if (!dryRun) renameSync(file, target)
  log(`  备份 ${file} -> ${target}`)
}

function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  if (!dryRun) renameSync(temp, file)
}

function accountId(email, taken) {
  const base = `acc_${createHash('sha1').update(email.trim().toLowerCase()).digest('hex').slice(0, 8)}`
  if (!taken.has(base)) return base
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `acc_${createHash('sha1').update(`${email}:${attempt}`).digest('hex').slice(0, 8)}`
    if (!taken.has(candidate)) return candidate
  }
  return `acc_${Date.now().toString(16).slice(-8)}`
}

/** Old read-state keys were bare Message-IDs or `local:<id>`. */
function convertReadKey(key) {
  const text = String(key ?? '').trim()
  if (text === '') return ''
  if (text.startsWith('mid:') || text.startsWith('local:')) return text
  return text.includes('@') ? `mid:${text}` : `local:${text}`
}

function convertDraft(draft, newAccountId) {
  return {
    id: String(draft.id),
    accountId: newAccountId,
    to: String(draft.to ?? ''),
    cc: String(draft.cc ?? ''),
    bcc: String(draft.bcc ?? ''),
    subject: String(draft.subject ?? ''),
    html: String(draft.bodyHtml ?? draft.html ?? draft.body ?? ''),
    attachments: Array.isArray(draft.attachments)
      ? draft.attachments
          .filter((file) => file !== null && typeof file === 'object')
          .map((file) => ({
            filename: String(file.filename ?? 'attachment'),
            contentType: String(file.contentType ?? 'application/octet-stream'),
            data: String(file.data ?? file.dataB64 ?? ''),
          }))
      : [],
    inReplyTo: String(draft.inReplyTo ?? ''),
    references: String(draft.references ?? ''),
    updatedAt: String(draft.updatedAt ?? draft.createdAt ?? new Date().toISOString()),
  }
}

function keychainRead(service, account) {
  try {
    const value = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return value.replace(/\r?\n$/, '')
  } catch {
    return undefined
  }
}

function keychainWrite(service, account, secret) {
  execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret], {
    timeout: 5000,
  })
}

function oldAccountDir(oldConfig, account) {
  const dataDir = typeof account.dataDir === 'string' ? account.dataDir.trim() : ''
  if (dataDir !== '') return isAbsolute(dataDir) ? dataDir : join(fromRoot, dataDir)
  if (typeof oldConfig.workspace === 'string' && oldConfig.workspace !== '') return oldConfig.workspace
  return join(fromRoot, 'accounts', String(account.id ?? 'acc_default'))
}

/** Legendary single-account configs stored the account fields at the top level. */
function oldAccounts(oldConfig) {
  if (Array.isArray(oldConfig.accounts) && oldConfig.accounts.length > 0) return oldConfig.accounts
  if (typeof oldConfig.account === 'string' && oldConfig.account !== '') {
    return [
      {
        id: 'acc_default',
        email: oldConfig.account,
        label: oldConfig.account,
        imap: oldConfig.imap,
        smtp: oldConfig.smtp,
        keychainService: oldConfig.keychain?.service ?? 'dsh-plugin-mail',
        dataDir: null,
      },
    ]
  }
  return []
}

function run() {
  log(`旧数据: ${fromRoot}`)
  log(`新数据: ${toRoot}`)
  if (!existsSync(fromRoot)) {
    console.error(`找不到旧插件目录: ${fromRoot}`)
    process.exitCode = 1
    return
  }
  const oldConfig = readJson(join(fromRoot, 'config.json'), {})
  const newConfig = readJson(toConfig, {})
  const accounts = Array.isArray(newConfig.accounts) ? [...newConfig.accounts] : []
  const taken = new Set(accounts.map((account) => account.id))
  const legacy = oldAccounts(oldConfig)
  if (legacy.length === 0) {
    console.error('旧配置里没有账号记录。')
    process.exitCode = 1
    return
  }
  let changed = false

  for (const old of legacy) {
    const email = String(old.email ?? '').trim()
    if (email === '') continue
    if (accountFilter !== '' && email.toLowerCase() !== accountFilter) continue
    if (old.auth?.type === 'oauth2') {
      log(`\n账号 ${email}`)
      log('  OAuth2 账号暂不支持（v0.2 提供），跳过')
      continue
    }
    const sourceDir = oldAccountDir(oldConfig, old)
    const sourceDb = join(sourceDir, 'mail.db')
    log(`\n账号 ${email}`)
    log(`  旧目录 ${sourceDir}`)
    if (!existsSync(sourceDb)) {
      log('  ⚠ 没有 mail.db，跳过（只迁移设置也可以，但没有本地备份可读）')
      continue
    }

    const existing = accounts.find((account) => String(account.email).toLowerCase() === email.toLowerCase())
    const newId = existing?.id ?? accountId(email, taken)
    taken.add(newId)
    const newService = existing?.keychainService ?? `dsh-mailharbor:${newId}`
    let targetDir
    if (copy) {
      targetDir = join(toRoot, 'accounts', newId)
      log(`  复制到 ${targetDir}`)
      if (!dryRun) {
        mkdirSync(targetDir, { recursive: true })
        cpSync(sourceDb, join(targetDir, 'mail.db'))
        for (const suffix of ['-wal', '-shm']) {
          if (existsSync(`${sourceDb}${suffix}`))
            cpSync(`${sourceDb}${suffix}`, join(targetDir, `mail.db${suffix}`))
        }
        if (existsSync(join(sourceDir, 'attachments'))) {
          cpSync(join(sourceDir, 'attachments'), join(targetDir, 'attachments'), { recursive: true })
        }
      }
    } else {
      targetDir = sourceDir
      log(`  直接沿用旧目录（不复制，节省空间）`)
    }

    if (existing === undefined) {
      accounts.push({
        id: newId,
        label: String(old.label ?? email),
        email,
        username: String(old.username ?? email),
        imap: {
          host: String(old.imap?.host ?? ''),
          port: Number(old.imap?.port) || 993,
          secure: old.imap?.secure !== false,
        },
        smtp: {
          host: String(old.smtp?.host ?? ''),
          port: Number(old.smtp?.port) || 465,
          secure: old.smtp?.secure !== false,
          fromName: String(old.smtp?.fromName ?? ''),
        },
        keychainService: newService,
        dataDir: targetDir,
        auth: { type: 'password' },
        caldav: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      })
      log('  新建账号记录')
    } else {
      existing.dataDir = targetDir
      log('  更新账号的数据目录')
    }
    changed = true

    // Read state: convert bare Message-IDs to the new key form.
    const readFile = join(sourceDir, 'read-state.json')
    if (existsSync(readFile)) {
      const current = readJson(readFile, {})
      const keys = Array.isArray(current) ? current : Array.isArray(current.unread) ? current.unread : []
      const converted = [...new Set(keys.map(convertReadKey).filter((key) => key !== ''))]
      if (converted.length !== keys.length || converted.some((key, index) => key !== keys[index])) {
        backupFile(readFile)
        atomicWrite(readFile, { unread: converted })
        log(`  已读状态: ${String(keys.length)} -> ${String(converted.length)} 个键`)
      }
    }

    // Drafts: old body/bodyHtml -> html, dataB64 -> data.
    const draftsFile = join(sourceDir, 'drafts.json')
    if (existsSync(draftsFile)) {
      const drafts = readJson(draftsFile, [])
      if (Array.isArray(drafts) && drafts.length > 0) {
        backupFile(draftsFile)
        atomicWrite(
          draftsFile,
          drafts.map((draft) => convertDraft(draft, newId)),
        )
        log(`  草稿: ${String(drafts.length)} 封`)
      }
    }

    // Password: copy the old keychain item when the new one is missing.
    if (process.platform === 'darwin') {
      const oldService = String(old.keychainService ?? oldConfig.keychain?.service ?? 'dsh-plugin-mail')
      const existingPassword = keychainRead(newService, email)
      if (existingPassword === undefined) {
        const oldPassword = keychainRead(oldService, email)
        if (oldPassword !== undefined) {
          if (!dryRun) keychainWrite(newService, email, oldPassword)
          log(`  钥匙串: 从 ${oldService} 复制到 ${newService}`)
        } else {
          log(`  钥匙串: 旧条目 ${oldService} 不存在，需要重新登录`)
        }
      } else {
        log('  钥匙串: 已有新密码，保持不动')
      }
    } else {
      log('  钥匙串: 非 macOS 平台，请在面板里重新登录')
    }
  }

  if (!changed) {
    log('\n没有需要迁移的账号。')
    return
  }

  const nextConfig = {
    ...newConfig,
    accounts,
    activeAccountId: newConfig.activeAccountId ?? accounts[0]?.id ?? null,
  }
  if (existsSync(toConfig)) backupFile(toConfig)
  atomicWrite(toConfig, nextConfig)
  log(`\n写入 ${toConfig}`)
  log(dryRun ? '预览完成；去掉 --dry-run 执行。' : '迁移完成。重新加载插件窗口即可看到旧的本地备份。')
}

run()
