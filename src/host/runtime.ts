import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Account, BackupStatus, ImapSettings } from '../shared/types.js'
import { CredentialManager } from './accounts.js'
import { AiService } from './ai.js'
import { AiThreadStore } from './ai-store.js'
import { MailFlagsStore } from './mail-flags.js'
import { backfillReferences, backfillSubjects } from './references.js'
import { ProjectStore } from './projects.js'
import { TaskStore } from './tasks.js'
import type { DshLlm, DshSessions, DshWorkspaceRegistry } from './dsh.js'
import { BackupEngine } from './backup.js'
import { DraftStore, draftPath } from './drafts.js'
import {
  type AccountRuntime,
  type MailHarborConfig,
  accountRuntime,
  activeAccount as pickActive,
  loadConfig,
  requireAccount,
} from './config.js'
import { accountDataDir } from './paths.js'
import { ImapProvider, type ImapCredentials } from './imap.js'
import { MailDatabase } from './mail-db.js'
import { ReadStateStore } from './read-state.js'

interface SignatureEntry<T> {
  signature: string
  value: T
}

export interface BackupJob {
  status: BackupStatus
  controller: AbortController
  promise: Promise<void>
}

const MAX_OUTPUT_LINES = 200

/**
 * Process-wide state for the plugin: one config, one credential manager, and
 * lazily created per-account providers and stores. Host code calls
 * {@link refresh} at the start of every request so external config edits are
 * picked up without a restart.
 */
export class MailHarborRuntime {
  private config: MailHarborConfig
  private configStamp = 0
  readonly credentials: CredentialManager
  private readonly providers = new Map<string, SignatureEntry<ImapProvider>>()
  private readonly databases = new Map<string, SignatureEntry<MailDatabase>>()
  private readonly draftStores = new Map<string, SignatureEntry<DraftStore>>()
  private readonly readStores = new Map<string, SignatureEntry<ReadStateStore>>()
  private readonly aiStores = new Map<string, SignatureEntry<AiThreadStore>>()
  private readonly backups = new Map<string, BackupJob>()
  private readonly llmProvider: () => DshLlm | undefined
  private readonly workspaceRegistryProvider: () => DshWorkspaceRegistry | undefined
  readonly sessions: DshSessions | undefined
  private aiService: AiService | null = null
  private projectStore: ProjectStore | null = null
  private taskStore: TaskStore | null = null
  private readonly flagStores = new Map<string, { signature: string; value: MailFlagsStore }>()
  private readonly referenceJobs = new Map<
    string,
    { running: boolean; indexed: number; remaining: number | null; error: string | null }
  >()
  private disposed = false

  constructor(
    options: {
      credentials?: CredentialManager
      llm?: () => DshLlm | undefined
      workspaceRegistry?: () => DshWorkspaceRegistry | undefined
      sessions?: DshSessions
    } = {},
  ) {
    this.config = loadConfig()
    this.credentials = options.credentials ?? new CredentialManager()
    this.llmProvider = options.llm ?? (() => undefined)
    this.workspaceRegistryProvider = options.workspaceRegistry ?? (() => undefined)
    this.sessions = options.sessions
  }

  get workspaceRegistry(): DshWorkspaceRegistry | undefined {
    return this.workspaceRegistryProvider()
  }

  projects(): ProjectStore {
    if (this.projectStore === null) {
      this.projectStore = new ProjectStore(join(this.config.dataDir, 'projects.json'))
    }
    return this.projectStore
  }

  tasks(): TaskStore {
    if (this.taskStore === null) {
      this.taskStore = new TaskStore(join(this.config.dataDir, 'state', 'state.db'))
    }
    return this.taskStore
  }

  /** The Host model service, when the composition provides one. */
  llm(): DshLlm | undefined {
    try {
      return this.llmProvider()
    } catch {
      return undefined
    }
  }

  ai(): AiService {
    if (this.aiService === null) {
      this.aiService = new AiService({
        config: () => this.config,
        llm: () => this.llm(),
        accountRoot: (account) => accountDataDir(account),
      })
    }
    return this.aiService
  }

  get current(): MailHarborConfig {
    return this.config
  }

  /** Re-read the config file when it changed on disk. */
  refresh(): MailHarborConfig {
    if (this.disposed) return this.config
    let stamp = 0
    try {
      const stats = statSync(this.config.configFile)
      stamp = stats.mtimeMs
    } catch {
      stamp = 0
    }
    if (stamp !== this.configStamp) {
      this.configStamp = stamp
      this.config = loadConfig()
      this.prune()
    }
    return this.config
  }

  private prune(): void {
    const live = new Set(this.config.accounts.map((account) => account.id))
    for (const id of [...this.providers.keys()]) {
      if (!live.has(id)) {
        void this.providers.get(id)?.value.dispose()
        this.providers.delete(id)
      }
    }
    for (const id of [...this.databases.keys()]) {
      if (!live.has(id)) {
        this.databases.get(id)?.value.close()
        this.databases.delete(id)
      }
    }
    for (const id of [...this.draftStores.keys()]) if (!live.has(id)) this.draftStores.delete(id)
    for (const id of [...this.readStores.keys()]) if (!live.has(id)) this.readStores.delete(id)
    for (const id of [...this.aiStores.keys()]) if (!live.has(id)) this.aiStores.delete(id)
  }

  /** Drop cached connections and stores for one account after a settings change. */
  invalidate(accountId: string): void {
    void this.providers.get(accountId)?.value.dispose()
    this.providers.delete(accountId)
    this.databases.get(accountId)?.value.close()
    this.databases.delete(accountId)
    this.draftStores.delete(accountId)
    this.readStores.delete(accountId)
    this.aiStores.delete(accountId)
    this.refresh()
  }

  active(): Account | null {
    return pickActive(this.config)
  }

  account(id?: string | null): Account {
    return requireAccount(this.config, id)
  }

  paths(account: Account): AccountRuntime {
    return accountRuntime(account)
  }

  referencesStatus(account: Account): {
    running: boolean
    indexed: number
    remaining: number | null
    error: string | null
  } {
    return (
      this.referenceJobs.get(account.id) ?? {
        running: false,
        indexed: 0,
        remaining: null,
        error: null,
      }
    )
  }

  /** Backfill In-Reply-To/References for archived mail, one batch at a time. */
  startReferencesBackfill(account: Account): void {
    const existing = this.referenceJobs.get(account.id)
    if (existing?.running === true) return
    const dbFile = this.paths(account).mailDb
    if (!existsSync(dbFile)) return
    const status = {
      running: true,
      indexed: 0,
      remaining: null as number | null,
      error: null as string | null,
    }
    this.referenceJobs.set(account.id, status)
    void (async () => {
      try {
        for (;;) {
          const result = backfillReferences(dbFile, 300)
          status.indexed += result.updated
          status.remaining = result.remaining
          if (result.remaining <= 0 || result.updated === 0) break
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        for (;;) {
          const result = backfillSubjects(dbFile, 300)
          status.indexed += result.updated
          status.remaining = result.remaining
          if (result.remaining <= 0 || result.updated === 0) break
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
      } catch (error) {
        status.error = error instanceof Error ? error.message : String(error)
      } finally {
        status.running = false
      }
    })()
  }

  /** Credentials for an account, with a clear message when the user must log in. */
  credentialsFor(account: Account): ImapCredentials {
    const resolved = this.credentials.resolve(account)
    if (resolved === undefined) throw new Error('请先登录邮箱账号')
    return { user: account.username || account.email, pass: resolved.password }
  }

  hasCredentials(account: Account): boolean {
    return this.credentials.resolve(account) !== undefined
  }

  imapSettings(account: Account): ImapSettings {
    return account.imap
  }

  provider(account: Account): ImapProvider {
    const signature = `${account.imap.host}:${String(account.imap.port)}:${String(account.imap.secure)}:${account.username}:${account.auth.type}`
    const existing = this.providers.get(account.id)
    if (existing !== undefined && existing.signature === signature) return existing.value
    if (existing !== undefined) void existing.value.dispose()
    const created = new ImapProvider(account.imap, this.credentialsFor(account), {
      onReconnect: () => {
        // Connection drops are expected on long-lived accounts; the next
        // operation reconnects transparently.
      },
    })
    this.providers.set(account.id, { signature, value: created })
    return created
  }

  database(account: Account): MailDatabase {
    const root = this.paths(account)
    const existing = this.databases.get(account.id)
    if (existing !== undefined && existing.signature === root.mailDb) return existing.value
    if (existing !== undefined) existing.value.close()
    const created = new MailDatabase(root.mailDb, {
      maxBodyChars: 400_000,
      attachmentsRoot: root.attachments,
    })
    this.databases.set(account.id, { signature: root.mailDb, value: created })
    return created
  }

  drafts(account: Account): DraftStore {
    const file = draftPath(this.paths(account).root)
    const existing = this.draftStores.get(account.id)
    if (existing !== undefined && existing.signature === file) return existing.value
    const created = new DraftStore(file, account.id)
    this.draftStores.set(account.id, { signature: file, value: created })
    return created
  }

  aiThreads(account: Account): AiThreadStore {
    const file = join(this.paths(account).root, 'ai-threads.json')
    const existing = this.aiStores.get(account.id)
    if (existing !== undefined && existing.signature === file) return existing.value
    const created = new AiThreadStore(file)
    this.aiStores.set(account.id, { signature: file, value: created })
    return created
  }

  flags(account: Account): MailFlagsStore {
    const file = join(this.paths(account).root, 'starred.json')
    const existing = this.flagStores.get(account.id)
    if (existing !== undefined && existing.signature === file) return existing.value
    const created = new MailFlagsStore(file)
    this.flagStores.set(account.id, { signature: file, value: created })
    return created
  }

  readState(account: Account): ReadStateStore {
    const file = join(this.paths(account).root, 'read-state.json')
    const existing = this.readStores.get(account.id)
    if (existing !== undefined && existing.signature === file) return existing.value
    const created = new ReadStateStore(file)
    this.readStores.set(account.id, { signature: file, value: created })
    return created
  }

  backupStatus(account: Account): BackupStatus {
    const job = this.backups.get(account.id)
    if (job !== undefined) return { ...job.status, output: [...job.status.output] }
    const persisted = BackupEngine.status(this.paths(account).mailDb)
    return { ...persisted, accountId: account.id }
  }

  /** Start an incremental backup; returns the job so the caller can stream output. */
  startBackup(
    account: Account,
    onEvent?: (event: { message: string; mailbox?: string; added?: number }) => void,
  ): BackupJob {
    const running = this.backups.get(account.id)
    if (running !== undefined && running.status.running) throw new Error('备份已在进行中')
    const controller = new AbortController()
    const previous = this.backups.get(account.id)?.status
    const status: BackupStatus = {
      running: true,
      accountId: account.id,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      total: 0,
      added: 0,
      message: '准备备份',
      output: [],
      exitCode: null,
    }
    const job: BackupJob = { status, controller, promise: Promise.resolve() }
    const engine = new BackupEngine(accountRuntime(account), this.credentialsFor(account), {
      onFlags: (entries) => {
        this.readState(account).sync(entries)
      },
    })
    job.promise = (async () => {
      try {
        const result = await engine.run({
          signal: controller.signal,
          onEvent: (event) => {
            status.message = event.message
            if (event.mailbox !== undefined) status.message = event.message
            if (event.added !== undefined) status.added = event.added
            if (event.total !== undefined) status.total = event.total
            status.output.push(event.message)
            if (status.output.length > MAX_OUTPUT_LINES)
              status.output.splice(0, status.output.length - MAX_OUTPUT_LINES)
            onEvent?.(event)
          },
        })
        status.total = result.total
        status.added = result.newCount
        status.exitCode = 0
        status.message = `备份完成：新增 ${String(result.newCount)} 封，共 ${String(result.total)} 封`
      } catch (error) {
        status.exitCode = 1
        status.message = error instanceof Error ? error.message : String(error)
        status.output.push(status.message)
      } finally {
        status.running = false
        status.finishedAt = new Date().toISOString()
        if (status.exitCode === 0) status.lastSuccessAt = status.finishedAt
        this.databases.get(account.id)?.value.close()
        this.databases.delete(account.id)
      }
    })()
    this.backups.set(account.id, job)
    return job
  }

  stopBackup(account: Account): boolean {
    const job = this.backups.get(account.id)
    if (job === undefined || !job.status.running) return false
    job.controller.abort()
    return true
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const job of this.backups.values()) job.controller.abort()
    for (const provider of this.providers.values()) await provider.value.dispose()
    this.providers.clear()
    for (const db of this.databases.values()) db.value.close()
    this.databases.clear()
    this.taskStore?.close()
  }
}
