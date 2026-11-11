import { createElement as h, useEffect, useState, type ReactNode } from 'react'
import type { Account, AppState, SettingsView } from '../shared/types.js'
import { api, ApiError, type AiModels, type AiStatus } from './api.js'
import { AddAccountForm } from './account-form.js'
import { Avatar, ErrorBar, Field, Toggle } from './components.js'

function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

export function MailSettings(): ReactNode {
  const [state, setState] = useState<AppState | null>(null)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [signature, setSignature] = useState('')
  const [markOnOpen, setMarkOnOpen] = useState(true)
  const [pollSeconds, setPollSeconds] = useState(60)
  const [listLimit, setListLimit] = useState(40)
  const [projectRoot, setProjectRoot] = useState('')
  const [aiEnabled, setAiEnabled] = useState(true)
  const [aiProvider, setAiProvider] = useState('deepseek-account')
  const [aiModel, setAiModel] = useState('deepseek-flash')
  const [aiSummaryLength, setAiSummaryLength] = useState<'brief' | 'normal' | 'detailed'>('brief')
  const [aiModels, setAiModels] = useState<AiModels>({ providers: [] })
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [styleText, setStyleText] = useState('')
  const [styleMeta, setStyleMeta] = useState({ updatedAt: '', sampleCount: 0 })
  const [styleBusy, setStyleBusy] = useState<'save' | 'learn' | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [checkResults, setCheckResults] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [tick, setTick] = useState(0)
  const [refIndex, setRefIndex] = useState<{
    running: boolean
    indexed: number
    remaining: number | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.state(), api.settings()])
      .then(([appState, view]) => {
        if (cancelled) return
        setState(appState)
        setSettings(view)
        setSignature(appState.settings.signature)
        setMarkOnOpen(view.read.markOnOpen)
        setPollSeconds(view.read.pollSeconds)
        setListLimit(view.render.listLimit)
        setProjectRoot(view.projects.root)
        setAiEnabled(view.ai.enabled)
        setAiProvider(view.ai.provider)
        setAiModel(view.ai.model)
        setAiSummaryLength(view.ai.summaryLength)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    let cancelled = false
    const accountId = settings?.activeAccountId ?? state?.activeAccountId ?? null
    if (accountId === null) return
    Promise.all([api.aiStatus(accountId), api.aiModels(), api.aiStyle(accountId)])
      .then(([status, models, style]) => {
        if (cancelled) return
        setAiStatus(status)
        setAiModels(models)
        setStyleText(style.style?.profile ?? '')
        setStyleMeta({
          updatedAt: style.style?.updatedAt ?? '',
          sampleCount: style.style?.sampleCount ?? 0,
        })
        const preferred =
          models.providers.find((item) => item.provider === status.provider) ?? models.providers[0]
        if (preferred !== undefined && status.provider === '') {
          setAiProvider(preferred.provider)
          const firstModel = preferred.models[0]
          if (firstModel !== undefined) setAiModel(firstModel.id)
        }
      })
      .catch(() => {
        // AI status is optional; the panel still works without a model service.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, settings?.activeAccountId])

  const activeId = settings?.activeAccountId ?? state?.activeAccountId ?? null
  useEffect(() => {
    if (activeId === null) return
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const status = await api.referencesStatus(activeId)
        if (cancelled) return
        setRefIndex(status)
        if (status.running) timer = window.setTimeout(() => void poll(), 1500)
      } catch {
        // The index is optional; ignore transient errors.
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeId])

  const reload = (): void => setTick((value) => value + 1)

  const notify = (message: string): void => {
    setToast(message)
    window.setTimeout(() => {
      setToast('')
    }, 3000)
  }

  const saveGeneral = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const result = await api.saveSettings(patch)
      setSettings(result.settings)
      notify('设置已保存')
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const exportConfig = async (): Promise<void> => {
    try {
      const data = await api.exportConfig()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `mailharbor-config-${new Date().toISOString().slice(0, 10)}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      notify('配置已导出')
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const importConfig = async (file: File): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const result = await api.importConfig(parsed)
      notify(`导入完成，新增 ${String(result.addedAccounts)} 个账号`)
      reload()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const account = settings?.accounts.find((item) => item.id === settings.activeAccountId) ?? null

  if (state === null || settings === null) {
    return h('div', { className: 'mailharbor mailharbor-settings' }, error === '' ? '正在加载设置…' : error)
  }

  return h(
    'div',
    { className: 'mailharbor mailharbor-settings-page' },
    h(
      'div',
      { className: 'mailharbor-settings' },
      h('h2', null, 'MailHarbor'),
      h('p', { className: 'small muted' }, '多账号 IMAP/SMTP 邮箱、本地备份、AI 与任务。设置会立即生效。'),
      toast === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-ok)' } }, toast),
      error === '' ? null : h(ErrorBar, { message: error, onDismiss: () => setError('') }),

      h(
        'div',
        { className: 'mailharbor-card' },
        h('h3', null, '账号'),
        settings.accounts.length === 0
          ? h(AddAccountForm, { onDone: () => reload() })
          : settings.accounts.map((item) =>
              h(AccountRow, {
                key: item.id,
                account: item,
                active: item.id === settings.activeAccountId,
                loggedIn: item.id === settings.activeAccountId ? state.loggedIn : undefined,
                editing: editing === item.id,
                checkResult: checkResults[item.id] ?? '',
                onToggleEdit: () => {
                  setEditing(editing === item.id ? null : item.id)
                  setCheckResults((prev) => ({ ...prev, [item.id]: '' }))
                },
                onActivate: async () => {
                  await api.activateAccount(item.id)
                  reload()
                },
                onLogin: async (password, remember) => {
                  await api.login(item.id, password, remember)
                  reload()
                },
                onLogout: async () => {
                  await api.logout(item.id)
                  reload()
                },
                onCheck: async () => {
                  try {
                    const result = await api.check(item.id)
                    setCheckResults((prev) => ({
                      ...prev,
                      [item.id]: `IMAP 正常（${String(result.imap.mailboxes.length)} 个文件夹）· SMTP ${result.smtp.ok ? '正常' : `失败: ${result.smtp.error ?? ''}`}`,
                    }))
                  } catch (caught) {
                    setCheckResults((prev) => ({ ...prev, [item.id]: `失败: ${errorText(caught)}` }))
                  }
                },
                onSave: async (patch) => {
                  await api.updateAccount(item.id, patch)
                  reload()
                },
                onRemove: async () => {
                  if (!window.confirm(`移除账号 ${item.email}？本地数据目录会保留。`)) return
                  await api.deleteAccount(item.id)
                  reload()
                },
              }),
            ),
        adding
          ? h(AddAccountForm, {
              onDone: () => {
                setAdding(false)
                reload()
              },
              onCancel: () => setAdding(false),
            })
          : h('button', { className: 'ghost', onClick: () => setAdding(true) }, '+ 添加账号'),
      ),

      h(
        'div',
        { className: 'mailharbor-card' },
        h('h3', null, '会话索引'),
        h(
          'p',
          { className: 'small muted' },
          '为旧邮件解析 In-Reply-To/References，让标题变了的回复也能归入同一会话。新邮件在备份时自动写入。',
        ),
        refIndex === null
          ? null
          : h(
              'p',
              { className: 'small' },
              refIndex.error !== null
                ? `索引出错：${refIndex.error}`
                : refIndex.running
                  ? `正在建立索引 · 已处理 ${String(refIndex.indexed)} 封 · 剩余 ${String(refIndex.remaining ?? '?')} 封`
                  : refIndex.remaining === 0
                    ? '旧邮件索引已完成。'
                    : `剩余 ${String(refIndex.remaining ?? '?')} 封待处理。`,
            ),
        h(
          'button',
          {
            className: 'ghost',
            disabled: refIndex?.running === true || activeId === null,
            onClick: () => {
              if (activeId === null) return
              void api
                .startReferencesBackfill(activeId)
                .then((status) => setRefIndex(status))
                .catch((caught: unknown) => setError(errorText(caught)))
            },
          },
          refIndex?.running === true ? '索引进行中…' : '重建旧邮件会话索引',
        ),
      ),
      h(
        'div',
        { className: 'mailharbor-card' },
        h('h3', null, '备份与迁移'),
        h('p', { className: 'small muted' }, '导出账号（不含密码）、签名与阅读设置；导入时按邮箱去重。'),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { className: 'ghost', onClick: () => void exportConfig() }, '导出配置'),
          h(
            'label',
            { className: 'ghost', style: { cursor: 'pointer' } },
            '导入配置',
            h('input', {
              type: 'file',
              accept: 'application/json,.json',
              style: { display: 'none' },
              onChange: (event: { target: { files?: FileList | null; value: string } }) => {
                const file = event.target.files?.[0]
                if (file !== undefined) void importConfig(file)
                event.target.value = ''
              },
            }),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mailharbor-card' },
        h('h3', null, '写信与阅读'),
        h(
          Field,
          { label: '签名（纯文本，发送时追加到正文末尾）' },
          h('textarea', {
            rows: 4,
            value: signature,
            onChange: (event: { target: { value: string } }) => setSignature(event.target.value),
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { className: 'ghost', onClick: () => void saveGeneral({ signature }) }, '保存签名'),
          h(Toggle, {
            checked: markOnOpen,
            onChange: (value) => {
              setMarkOnOpen(value)
              void saveGeneral({ read: { markOnOpen: value } })
            },
            label: '打开邮件时标为已读',
          }),
        ),
        h(
          'div',
          { className: 'mailharbor-grid' },
          h(
            Field,
            { label: '列表每页数量' },
            h('input', {
              type: 'number',
              min: 10,
              max: 200,
              value: listLimit,
              onChange: (event: { target: { value: string } }) => setListLimit(Number(event.target.value)),
              onBlur: () => void saveGeneral({ render: { listLimit } }),
            }),
          ),
          h(
            Field,
            { label: '未读角标轮询（秒）' },
            h('input', {
              type: 'number',
              min: 15,
              max: 3600,
              value: pollSeconds,
              onChange: (event: { target: { value: string } }) => setPollSeconds(Number(event.target.value)),
              onBlur: () => void saveGeneral({ read: { pollSeconds } }),
            }),
          ),
        ),
      ),

      h(
        'div',
        { className: 'mailharbor-card' },
        h('h3', null, '项目'),
        h('p', { className: 'small muted' }, '从邮件创建项目时的默认目录；单个项目可以在创建时改。'),
        h(
          'div',
          { className: 'mailharbor-grid', style: { gridTemplateColumns: 'minmax(0, 1fr) auto' } },
          h(
            Field,
            { label: '默认项目目录' },
            h('input', {
              value: projectRoot,
              onChange: (event: { target: { value: string } }) => setProjectRoot(event.target.value),
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', alignSelf: 'end' } },
            h(
              'button',
              {
                className: 'ghost small',
                onClick: () => {
                  void api
                    .pickDirectory()
                    .then((result) => {
                      if (result.path !== null) setProjectRoot(result.path)
                    })
                    .catch((caught: unknown) => setError(errorText(caught)))
                },
              },
              '浏览…',
            ),
            h(
              'button',
              {
                className: 'ghost small',
                onClick: () => void saveGeneral({ projects: { root: projectRoot } }),
              },
              '保存目录',
            ),
          ),
        ),
      ),

      h(
        'div',
        { className: 'mailharbor-card' },
        h('h3', null, 'AI'),
        h(
          'div',
          { className: 'mailharbor-field' },
          h('label', null, '摘要详细程度'),
          h(
            'select',
            {
              value: aiSummaryLength,
              onChange: (event: { target: { value: string } }) => {
                const next = event.target.value as 'brief' | 'normal' | 'detailed'
                setAiSummaryLength(next)
                void saveGeneral({ ai: { summaryLength: next } })
              },
            },
            h('option', { value: 'brief' }, '简洁（默认，≤180 字）'),
            h('option', { value: 'normal' }, '标准（≤400 字）'),
            h('option', { value: 'detailed' }, '详细（更完整的背景与要点）'),
          ),
        ),
        h(Toggle, {
          checked: aiEnabled,
          onChange: (value) => {
            setAiEnabled(value)
            void saveGeneral({ ai: { enabled: value } })
          },
          label: '启用 AI（摘要、AI 回复、翻译、写作风格）',
        }),
        aiStatus === null
          ? null
          : h(
              'div',
              { className: 'small', style: { color: aiStatus.available ? 'var(--m-ok)' : 'var(--m-warn)' } },
              aiStatus.available
                ? `模型服务可用 · ${aiStatus.provider} / ${aiStatus.model}`
                : (aiStatus.error ?? '当前 DSH 组合没有可用的模型服务'),
            ),
        h(
          'div',
          { className: 'mailharbor-grid' },
          h(
            Field,
            { label: 'Provider' },
            aiModels.providers.length === 0
              ? h('input', {
                  value: aiProvider,
                  onChange: (event: { target: { value: string } }) => setAiProvider(event.target.value),
                  onBlur: () => void saveGeneral({ ai: { provider: aiProvider } }),
                })
              : h(
                  'select',
                  {
                    value: aiProvider,
                    onChange: (event: { target: { value: string } }) => {
                      setAiProvider(event.target.value)
                      const provider = aiModels.providers.find((item) => item.provider === event.target.value)
                      const first = provider?.models[0]
                      if (first !== undefined) setAiModel(first.id)
                      void saveGeneral({
                        ai: {
                          provider: event.target.value,
                          ...(first === undefined ? {} : { model: first.id }),
                        },
                      })
                    },
                  },
                  aiModels.providers.map((item) =>
                    h('option', { key: item.provider, value: item.provider }, item.name),
                  ),
                ),
          ),
          h(
            Field,
            { label: '模型' },
            (() => {
              const provider = aiModels.providers.find((item) => item.provider === aiProvider)
              return provider === undefined || provider.models.length === 0
                ? h('input', {
                    value: aiModel,
                    onChange: (event: { target: { value: string } }) => setAiModel(event.target.value),
                    onBlur: () => void saveGeneral({ ai: { model: aiModel } }),
                  })
                : h(
                    'select',
                    {
                      value: aiModel,
                      onChange: (event: { target: { value: string } }) => {
                        setAiModel(event.target.value)
                        void saveGeneral({ ai: { model: event.target.value } })
                      },
                    },
                    provider.models.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                  )
            })(),
          ),
        ),
        h('hr', null),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('strong', { style: { fontSize: '12.5px' } }, '写作风格'),
          h(
            'span',
            { className: 'small muted' },
            styleMeta.updatedAt === ''
              ? '还没有生成'
              : `${styleMeta.sampleCount} 封已发送邮件 · ${new Date(styleMeta.updatedAt).toLocaleString()}`,
          ),
        ),
        h(
          'p',
          { className: 'small muted' },
          '从已发送邮件学习你的称呼、结尾、语气和常用表达，AI 回复时会参考它。只保存提炼后的档案，不保存邮件原文。',
        ),
        h('textarea', {
          rows: 6,
          value: styleText,
          placeholder: '点「从已发送邮件学习」生成，或直接写一段你的写作风格',
          onChange: (event: { target: { value: string } }) => setStyleText(event.target.value),
        }),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h(
            'button',
            {
              className: 'ghost',
              disabled: styleBusy !== null,
              onClick: () => {
                const accountId = settings.activeAccountId
                if (accountId === null) return
                setStyleBusy('learn')
                setError('')
                api
                  .aiLearnStyle(accountId)
                  .then((result) => {
                    setStyleText(result.style.profile)
                    setStyleMeta({ updatedAt: result.style.updatedAt, sampleCount: result.style.sampleCount })
                    notify('已根据已发送邮件生成写作风格')
                  })
                  .catch((caught: unknown) => setError(errorText(caught)))
                  .finally(() => setStyleBusy(null))
              },
            },
            styleBusy === 'learn' ? '学习中…' : '从已发送邮件学习',
          ),
          h(
            'button',
            {
              className: 'primary',
              disabled: styleBusy !== null || styleText.trim() === '',
              onClick: () => {
                const accountId = settings.activeAccountId
                if (accountId === null) return
                setStyleBusy('save')
                setError('')
                api
                  .aiSaveStyle(accountId, styleText)
                  .then((result) => {
                    setStyleMeta({ updatedAt: result.style.updatedAt, sampleCount: result.style.sampleCount })
                    notify('写作风格已保存')
                  })
                  .catch((caught: unknown) => setError(errorText(caught)))
                  .finally(() => setStyleBusy(null))
              },
            },
            '保存风格',
          ),
        ),
        h(
          'p',
          { className: 'small muted' },
          'AI 调用走 DSH 自己的模型服务，不额外保存密钥；发送仍然只由你确认。',
        ),
      ),

      h(
        'div',
        { className: 'mailharbor-card' },
        h('h3', null, '数据'),
        h(
          'dl',
          { className: 'mailharbor-kv' },
          h('dt', null, '数据目录'),
          h('dd', null, settings.dataDir),
          h('dt', null, '配置文件'),
          h('dd', null, settings.configFile),
          h('dt', null, '当前账号数据库'),
          h(
            'dd',
            null,
            account === null
              ? '—'
              : `${account.dataDir.startsWith('/') ? account.dataDir : `${settings.dataDir}/${account.dataDir}`}/mail.db`,
          ),
          h('dt', null, '插件版本'),
          h('dd', null, state.version),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          account === null
            ? null
            : h(
                'button',
                {
                  className: 'ghost',
                  onClick: async () => {
                    try {
                      const status = await api.startBackup(account.id)
                      notify(status.status.message === '' ? '备份已开始' : status.status.message)
                      reload()
                    } catch (caught) {
                      setError(errorText(caught))
                    }
                  },
                },
                '立即备份当前账号',
              ),
        ),
      ),
    ),
  )
}

function AccountRow({
  account,
  active,
  loggedIn,
  editing,
  checkResult,
  onToggleEdit,
  onActivate,
  onLogin,
  onLogout,
  onCheck,
  onSave,
  onRemove,
}: {
  account: Account
  active: boolean
  loggedIn: boolean | undefined
  editing: boolean
  checkResult: string
  onToggleEdit: () => void
  onActivate: () => Promise<void>
  onLogin: (password: string, remember: boolean) => Promise<void>
  onLogout: () => Promise<void>
  onCheck: () => Promise<void>
  onSave: (patch: Record<string, unknown>) => Promise<void>
  onRemove: () => Promise<void>
}): ReactNode {
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [label, setLabel] = useState(account.label)
  const [username, setUsername] = useState(account.username)
  const [imapHost, setImapHost] = useState(account.imap.host)
  const [imapPort, setImapPort] = useState(String(account.imap.port))
  const [imapSecure, setImapSecure] = useState(account.imap.secure)
  const [smtpHost, setSmtpHost] = useState(account.smtp.host)
  const [smtpPort, setSmtpPort] = useState(String(account.smtp.port))
  const [smtpSecure, setSmtpSecure] = useState(account.smtp.secure)
  const [fromName, setFromName] = useState(account.smtp.fromName)
  const [accountSignature, setAccountSignature] = useState(account.signature ?? '')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setLabel(account.label)
    setUsername(account.username)
    setImapHost(account.imap.host)
    setImapPort(String(account.imap.port))
    setImapSecure(account.imap.secure)
    setSmtpHost(account.smtp.host)
    setSmtpPort(String(account.smtp.port))
    setSmtpSecure(account.smtp.secure)
    setFromName(account.smtp.fromName)
    setAccountSignature(account.signature ?? '')
  }, [account])

  const wrap = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await operation()
    } finally {
      setBusy(false)
    }
  }

  return h(
    'div',
    { className: 'mailharbor-card', style: { background: 'var(--m-bg-1)' } },
    h(
      'div',
      { className: 'mailharbor-account-row' },
      h(Avatar, { email: account.email, size: 30 }),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
        h('strong', null, account.label),
        h('span', { className: 'small muted' }, account.email),
      ),
      active ? h('span', { className: 'badge ok' }, '当前账号') : null,
      loggedIn === false ? h('span', { className: 'badge warn' }, '未登录') : null,
      h('span', { className: 'spacer' }),
      active
        ? null
        : h('button', { className: 'ghost small', onClick: () => void wrap(onActivate) }, '设为当前'),
      h(
        'button',
        {
          className: 'ghost small',
          disabled: checking,
          onClick: () => {
            setChecking(true)
            void wrap(onCheck).finally(() => setChecking(false))
          },
        },
        checking ? '检查中…' : '检查连接',
      ),
      h('button', { className: 'ghost small', onClick: onToggleEdit }, editing ? '收起' : '编辑'),
    ),
    checkResult === ''
      ? null
      : h(
          'div',
          {
            className: 'mailharbor-check',
            style: { color: checkResult.startsWith('失败') ? 'var(--m-danger)' : 'var(--m-ok)' },
          },
          checkResult,
        ),
    editing
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(
            'div',
            { className: 'mailharbor-grid' },
            h(
              Field,
              { label: '显示名称' },
              h('input', {
                value: label,
                onChange: (event: { target: { value: string } }) => setLabel(event.target.value),
              }),
            ),
            h(
              Field,
              { label: '登录用户名' },
              h('input', {
                value: username,
                onChange: (event: { target: { value: string } }) => setUsername(event.target.value),
              }),
            ),
          ),
          h(
            'div',
            { className: 'mailharbor-grid three' },
            h(
              Field,
              { label: 'IMAP 主机' },
              h('input', {
                value: imapHost,
                onChange: (event: { target: { value: string } }) => setImapHost(event.target.value),
              }),
            ),
            h(
              Field,
              { label: '端口' },
              h('input', {
                value: imapPort,
                onChange: (event: { target: { value: string } }) => setImapPort(event.target.value),
              }),
            ),
            h(Toggle, { checked: imapSecure, onChange: setImapSecure, label: 'TLS' }),
          ),
          h(
            'div',
            { className: 'mailharbor-grid three' },
            h(
              Field,
              { label: 'SMTP 主机' },
              h('input', {
                value: smtpHost,
                onChange: (event: { target: { value: string } }) => setSmtpHost(event.target.value),
              }),
            ),
            h(
              Field,
              { label: '端口' },
              h('input', {
                value: smtpPort,
                onChange: (event: { target: { value: string } }) => setSmtpPort(event.target.value),
              }),
            ),
            h(Toggle, { checked: smtpSecure, onChange: setSmtpSecure, label: 'TLS' }),
          ),
          h(
            Field,
            { label: '发件人名称' },
            h('input', {
              value: fromName,
              onChange: (event: { target: { value: string } }) => setFromName(event.target.value),
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'button',
              {
                className: 'primary small',
                disabled: busy,
                onClick: () =>
                  void wrap(async () => {
                    await onSave({
                      label,
                      username,
                      imap: { host: imapHost, port: Number(imapPort) || 993, secure: imapSecure },
                      smtp: { host: smtpHost, port: Number(smtpPort) || 465, secure: smtpSecure, fromName },
                      signature: accountSignature,
                    })
                  }),
              },
              '保存账号',
            ),
            h(
              'button',
              {
                className: 'ghost small danger',
                onClick: () => void wrap(onRemove),
              },
              '移除账号',
            ),
          ),
          h('hr', { style: { border: 0, borderTop: '1px solid var(--m-line)', width: '100%' } }),
          h(
            Field,
            { label: '密码 / 应用专用密码（不写入配置文件）' },
            h('input', {
              type: 'password',
              value: password,
              onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h(Toggle, { checked: remember, onChange: setRemember, label: '记住密码' }),
            h(
              'button',
              {
                className: 'primary small',
                disabled: busy || password === '',
                onClick: () =>
                  void wrap(async () => {
                    await onLogin(password, remember)
                    setPassword('')
                  }),
              },
              '登录',
            ),
            h('button', { className: 'ghost small', onClick: () => void wrap(onLogout) }, '退出登录'),
          ),
        )
      : null,
  )
}
