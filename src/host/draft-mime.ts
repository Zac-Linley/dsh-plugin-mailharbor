import { createTransport } from 'nodemailer'
import type { Draft } from '../shared/types.js'

/** Build the RFC 5322 message stored in IMAP Drafts. */
export async function draftMime(
  account: { email: string; smtp: { fromName: string } },
  draft: Draft,
): Promise<Buffer> {
  const transport = createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  const from = account.smtp.fromName === '' ? account.email : `"${account.smtp.fromName}" <${account.email}>`
  const info = await transport.sendMail({
    from,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.html,
    attachments: draft.attachments.map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      content: Buffer.from(file.data, 'base64'),
    })),
    ...(draft.inReplyTo === undefined ? {} : { inReplyTo: draft.inReplyTo }),
    ...(draft.references === undefined ? {} : { references: draft.references }),
  })
  if (Buffer.isBuffer(info.message)) return info.message
  return Buffer.from(info.message as unknown as string)
}
