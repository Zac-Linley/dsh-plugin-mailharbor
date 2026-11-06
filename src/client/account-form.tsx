import { createElement as h, useState, type ReactNode } from 'react'
import type { Account, AppState } from '../shared/types.js'
import { api, ApiError } from './api.js'
import { Field, Modal, Toggle } from './components.js'

function domainOf(email: string): string {
  return email.split('@')[1] ?? 'example.com'
}

function errorText(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error)
}

export function AddAccountForm({
  onDone,
  onCancel,
}: {
  onDone: (state: AppState) => void
  onCancel?: () => void
}): ReactNode {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const [remember, setRemember] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [imapSecure, setImapSecure] = useState(true)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('465')
  const [smtpSecure, setSmtpSecure] = useState(true)
  const [fromName, setFromName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const domain = domainOf(email)
      const { state } = await api.addAccount({
        email: email.trim(),
        password,
        remember,
        ...(label.trim() === '' ? {} : { label: label.trim() }),
        ...(advanced
          ? {
              imap: {
                host: imapHost.trim() === '' ? `imap.${domain}` : imapHost.trim(),
                port: Number(imapPort) || 993,
                secure: imapSecure,
              },
              smtp: {
                host: smtpHost.trim() === '' ? `smtp.${domain}` : smtpHost.trim(),
                port: Number(smtpPort) || 465,
                secure: smtpSecure,
                ...(fromName.trim() === '' ? {} : { fromName: fromName.trim() }),
              },
            }
          : {}),
      })
      onDone(state)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return h(
    'div',
    { className: 'mailharbor-card' },
    h('h3', null, '添加邮箱账号'),
    h(
      'div',
      { className: 'mailharbor-grid' },
      h(
        Field,
        { label: '邮箱地址' },
        h('input', {
          type: 'email',
          value: email,
          placeholder: 'you@example.com',
          onChange: (event: { target: { value: string } }) => setEmail(event.target.value),
          autoFocus: true,
        }),
      ),
      h(
        Field,
        { label: '密码 / 应用专用密码' },
        h('input', {
          type: 'password',
          value: password,
          onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
        }),
      ),
    ),
    h(
      Field,
      { label: '显示名称（可选）' },
      h('input', {
        value: label,
        placeholder: '工作邮箱',
        onChange: (event: { target: { value: string } }) => setLabel(event.target.value),
      }),
    ),
    h(Toggle, { checked: remember, onChange: setRemember, label: '记住密码（写入系统钥匙串）' }),
    h(
      'button',
      { className: 'ghost', onClick: () => setAdvanced(!advanced) },
      advanced ? '隐藏高级设置' : '高级设置（服务器与端口）',
    ),
    advanced
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(
            'div',
            { className: 'mailharbor-grid three' },
            h(
              Field,
              { label: 'IMAP 主机' },
              h('input', {
                value: imapHost,
                placeholder: `imap.${domainOf(email)}`,
                onChange: (event: { target: { value: string } }) => setImapHost(event.target.value),
              }),
            ),
            h(
              Field,
              { label: '端口' },
              h('input', {
                value: imapPort,
                inputMode: 'numeric',
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
                placeholder: `smtp.${domainOf(email)}`,
                onChange: (event: { target: { value: string } }) => setSmtpHost(event.target.value),
              }),
            ),
            h(
              Field,
              { label: '端口' },
              h('input', {
                value: smtpPort,
                inputMode: 'numeric',
                onChange: (event: { target: { value: string } }) => setSmtpPort(event.target.value),
              }),
            ),
            h(Toggle, { checked: smtpSecure, onChange: setSmtpSecure, label: 'TLS' }),
          ),
          h(
            Field,
            { label: '发件人名称（可选）' },
            h('input', {
              value: fromName,
              onChange: (event: { target: { value: string } }) => setFromName(event.target.value),
            }),
          ),
        )
      : null,
    error === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-danger)' } }, error),
    h(
      'div',
      { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
      onCancel === undefined ? null : h('button', { className: 'ghost', onClick: onCancel }, '取消'),
      h(
        'button',
        {
          className: 'primary',
          onClick: () => void submit(),
          disabled: busy || email.trim() === '' || password === '',
        },
        busy ? '连接中…' : '添加并连接',
      ),
    ),
  )
}

export function LoginForm({ account, onDone }: { account: Account; onDone: () => void }): ReactNode {
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.login(account.id, password, remember)
      onDone()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }
  return h(
    'div',
    { className: 'mailharbor-card' },
    h('h3', null, `登录 ${account.email}`),
    h(
      'p',
      { className: 'small muted' },
      `${account.imap.host}:${String(account.imap.port)} · ${account.smtp.host}:${String(account.smtp.port)}`,
    ),
    h(
      Field,
      { label: '密码 / 应用专用密码' },
      h('input', {
        type: 'password',
        value: password,
        onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Enter') void submit()
        },
        autoFocus: true,
      }),
    ),
    h(Toggle, { checked: remember, onChange: setRemember, label: '记住密码（写入系统钥匙串）' }),
    error === '' ? null : h('div', { className: 'small', style: { color: 'var(--m-danger)' } }, error),
    h(
      'button',
      { className: 'primary', onClick: () => void submit(), disabled: busy || password === '' },
      busy ? '登录中…' : '登录',
    ),
  )
}

export function AddAccountModal({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (state: AppState) => void
}): ReactNode {
  return h(
    Modal,
    { title: '添加邮箱账号', onClose },
    h(AddAccountForm, {
      onDone: (state) => {
        onDone(state)
        onClose()
      },
      onCancel: onClose,
    }),
  )
}

export { errorText }
