/** Cross-panel navigation requests (tasks → mail). */
export interface OpenMailRequest {
  accountId: string
  id: string
  mailbox: string
}

let pending: OpenMailRequest | null = null

export function requestOpenMail(request: OpenMailRequest): void {
  pending = request
  window.dispatchEvent(new CustomEvent('mailharbor:open-mail', { detail: request }))
}

/** Consume a request queued while the mail panel was unmounted. */
export function consumeOpenMail(): OpenMailRequest | null {
  const value = pending
  pending = null
  return value
}
