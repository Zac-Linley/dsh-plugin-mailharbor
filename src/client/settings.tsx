import { createElement as h, useEffect, useState, type ReactNode } from 'react'
import type { Account, AppState, SettingsView } from '../shared/types.js'
import { api, ApiError } from './api.js'
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
  const [aiEnabled, setAiEnabled] = useState(true)
  const [aiProvider, setAiProvider] = useState('deepseek-account')
  const [aiModel, setAiModel] = useState('deepseek-flash')
  const [editing, setEditing] = useState<string | null>(null)
  const [checkResult, setCheckResult] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [tick, setTick] = useState(0)

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
        setAiEnabled(view.ai.enabled)
        setAiProvider(view.ai.provider)
        setAiModel(view.ai.model)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

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

  const account = settings?.accounts.find((item) => item.id === settings.activeAccountId) ?? null

  if (state === null || settings === null) {
    return h('div', { className: 'mailharbor mailharbor-settings' }, error === '' ? '正在加载设置…' : error)
  }

  return h(
    'div',
    { className: 'mailharbor' },
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
                checkResult: editing === item.id ? checkResult : '',
                onToggleEdit: () => {
                  setEditing(editing === item.id ? null : item.id)
                  setCheckResult('')
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
                    setCheckResult(
                      `IMAP 正常（${String(result.imap.mailboxes.length)} 个文件夹）· SMTP ${result.smtp.ok ? '正常' : `失败: ${result.smtp.error ?? ''}`}`,
                    )
                  } catch (caught) {
                    setCheckResult(`失败: ${errorText(caught)}`)
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
        h('h3', null, 'AI'),
        h(Toggle, {
          checked: aiEnabled,
          onChange: (value) => {
            setAiEnabled(value)
            void saveGeneral({ ai: { enabled: value } })
          },
          label: '启用 AI（摘要、起草、润色、自然语言搜索）',
        }),
        h(
          'div',
          { className: 'mailharbor-grid' },
          h(
            Field,
            { label: 'Provider' },
            h('input', {
              value: aiProvider,
              onChange: (event: { target: { value: string } }) => setAiProvider(event.target.value),
              onBlur: () => void saveGeneral({ ai: { provider: aiProvider } }),
            }),
          ),
          h(
            Field,
            { label: '模型' },
            h('input', {
              value: aiModel,
              onChange: (event: { target: { value: string } }) => setAiModel(event.target.value),
              onBlur: () => void saveGeneral({ ai: { model: aiModel } }),
            }),
          ),
        ),
        h(
          'p',
          { className: 'small muted' },
          'AI 调用走 DSH 自己的模型服务，不额外保存密钥。AI 面板功能将在 v0.2 提供。',
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
          h('dd', null, account === null ? '—' : `${settings.dataDir}/accounts/${account.id}/mail.db`),
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
  const [busy, setBusy] = useState(false)

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
      h('button', { className: 'ghost small', onClick: () => void wrap(onCheck) }, '检查连接'),
      h('button', { className: 'ghost small', onClick: onToggleEdit }, editing ? '收起' : '编辑'),
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
          checkResult === '' ? null : h('div', { className: 'small muted' }, checkResult),
        )
      : null,
  )
}
