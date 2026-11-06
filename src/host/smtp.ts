import nodemailer from 'nodemailer'
import type { SendResult, SmtpSettings } from '../shared/types.js'
import { addressOf, isEmail } from './address.js'

export interface SmtpCredentials {
  user: string
  pass?: string
  accessToken?: string
}

export interface OutgoingMail {
  from?: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  text: string
  html?: string
  inReplyTo?: string
  references?: string
  attachments?: { filename: string; contentType: string; content: Buffer }[]
}

function transportOptions(settings: SmtpSettings, credentials: SmtpCredentials) {
  const secure = settings.secure !== false
  return {
    host: settings.host,
    port: Number(settings.port),
    secure,
    // Plain submission ports must upgrade; never send credentials in the clear.
    requireTLS: !secure,
    auth:
      credentials.accessToken !== undefined
        ? { type: 'OAuth2' as const, user: credentials.user, accessToken: credentials.accessToken }
        : { user: credentials.user, pass: credentials.pass ?? '' },
    tls: { rejectUnauthorized: true, servername: settings.host },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000,
    pool: false,
  }
}

function createTransport(settings: SmtpSettings, credentials: SmtpCredentials) {
  return nodemailer.createTransport(transportOptions(settings, credentials))
}

/** Validate one recipient header into envelope addresses. */
export function recipientsOf(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => addressOf(part))
    .filter((address) => isEmail(address))
}

/** Check credentials and connectivity without sending a message. */
export async function verifySmtp(
  settings: SmtpSettings,
  credentials: SmtpCredentials,
): Promise<{ ok: true; host: string; port: number }> {
  const transport = createTransport(settings, credentials)
  try {
    await transport.verify()
    return { ok: true, host: settings.host, port: Number(settings.port) }
  } finally {
    transport.close()
  }
}

/**
 * Send one message: plain text plus an optional HTML alternative and files.
 * nodemailer builds the MIME tree, so encodings, long headers and 8-bit bodies
 * do not depend on hand-written RFC 5322 code.
 */
export async function sendMail(
  settings: SmtpSettings,
  credentials: SmtpCredentials,
  account: string,
  mail: OutgoingMail,
): Promise<SendResult> {
  const from = addressOf(mail.from ?? account)
  if (!isEmail(from)) throw new Error('发件人地址无效')
  const to = recipientsOf(mail.to)
  const cc = recipientsOf(mail.cc ?? '')
  if (to.length === 0) throw new Error('收件人不能为空')

  const transport = createTransport(settings, credentials)
  try {
    const info = await transport.sendMail({
      from: settings.fromName === '' ? from : { name: settings.fromName, address: from },
      to,
      ...(cc.length > 0 ? { cc } : {}),
      subject: mail.subject,
      text: mail.text,
      ...(mail.html !== undefined && mail.html.trim() !== '' ? { html: mail.html } : {}),
      ...(mail.inReplyTo !== undefined && mail.inReplyTo !== '' ? { inReplyTo: mail.inReplyTo } : {}),
      ...(mail.references !== undefined && mail.references !== '' ? { references: mail.references } : {}),
      ...(mail.attachments !== undefined && mail.attachments.length > 0
        ? {
            attachments: mail.attachments.map((file) => ({
              filename: file.filename,
              content: file.content,
              contentType: file.contentType,
            })),
          }
        : {}),
    })
    return {
      messageId: String(info.messageId ?? ''),
      accepted: (info.accepted ?? []).map((entry) => String(entry)),
      rejected: (info.rejected ?? []).map((entry) => String(entry)),
    }
  } finally {
    transport.close()
  }
}
