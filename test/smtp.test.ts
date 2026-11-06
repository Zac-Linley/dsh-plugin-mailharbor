import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { htmlToText } from '../src/host/html.js'
import { recipientsOf, sendMail, verifySmtp } from '../src/host/smtp.js'

const tlsDir = join(import.meta.dirname, 'fixtures', 'tls')
const key = readFileSync(join(tlsDir, 'key.pem'))
const cert = readFileSync(join(tlsDir, 'cert.pem'))

let server: SMTPServer
let port = 0
const received: string[] = []

beforeAll(async () => {
  server = new SMTPServer({
    secure: false,
    key,
    cert,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _session, callback) {
      if (auth.username === 'me@example.com' && auth.password === 'secret') {
        callback(null, { user: auth.username })
        return
      }
      callback(new Error('invalid credentials'))
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'))
        callback()
      })
    },
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  port = (server.server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
})

const settings = (): { host: string; port: number; secure: boolean; fromName: string } => ({
  host: '127.0.0.1',
  port,
  secure: false,
  fromName: 'MailHarbor',
})
const security = { allowSelfSigned: true }

describe('SMTP transport', () => {
  it('verifies STARTTLS and credentials', async () => {
    const result = await verifySmtp(settings(), { user: 'me@example.com', pass: 'secret' }, security)
    expect(result).toEqual({ ok: true, host: '127.0.0.1', port })
  })

  it('rejects wrong credentials', async () => {
    await expect(
      verifySmtp(settings(), { user: 'me@example.com', pass: 'wrong' }, security),
    ).rejects.toThrow()
  })

  it('sends text, an HTML alternative and an attachment over STARTTLS', async () => {
    received.length = 0
    const result = await sendMail(
      settings(),
      { user: 'me@example.com', pass: 'secret' },
      'me@example.com',
      {
        to: 'Alice <alice@example.com>, bob@example.com',
        cc: 'carol@example.com',
        subject: 'Quarterly report',
        text: 'Plain body',
        html: '<p>Hello <b>there</b></p>',
        inReplyTo: 'parent@example.com',
        references: 'root@example.com parent@example.com',
        attachments: [
          { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('hello attachment') },
        ],
      },
      security,
    )

    expect(result.accepted.sort()).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com'])
    expect(result.rejected).toEqual([])
    expect(result.messageId).toContain('@')

    expect(received).toHaveLength(1)
    const raw = received[0] ?? ''
    expect(raw).toContain('Subject: Quarterly report')
    expect(raw).toContain('Content-Type: multipart/mixed')
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('In-Reply-To: <parent@example.com>')
    expect(raw).toContain('References: <root@example.com> <parent@example.com>')
    expect(raw).toContain('filename=notes.txt')
    // base64 of "hello attachment"
    expect(raw).toContain('aGVsbG8gYXR0YWNobWVudA==')
    expect(raw).toMatch(/From: MailHarbor <me@example\.com>/)
  })

  it('requires a recipient', async () => {
    await expect(
      sendMail(settings(), { user: 'me@example.com', pass: 'secret' }, 'me@example.com', {
        to: ' , ',
        subject: 'x',
        text: 'x',
      }),
    ).rejects.toThrow('收件人不能为空')
  })
})

describe('message helpers', () => {
  it('splits recipient headers and drops invalid entries', () => {
    expect(
      recipientsOf('Alice <alice@example.com>, bob@example.com; "Doe, J" <j@example.com>, nope'),
    ).toEqual(['alice@example.com', 'bob@example.com', 'j@example.com'])
  })

  it('converts composer HTML into readable text', () => {
    expect(htmlToText('<p>Hello <b>there</b></p><ul><li>One</li><li>Two</li></ul>')).toBe(
      'Hello there\n• One\n• Two',
    )
    expect(htmlToText('<script>alert(1)</script><p>&amp; done&nbsp;!</p>')).toBe('& done !')
  })
})
