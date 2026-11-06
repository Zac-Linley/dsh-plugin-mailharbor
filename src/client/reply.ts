/** A reply prepared by AI (or a card) and handed to the composer. */
export interface AiReplyInit {
  to: string
  cc: string
  subject: string
  html: string
  inReplyTo?: string
  references?: string
}
