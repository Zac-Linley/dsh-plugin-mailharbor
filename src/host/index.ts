import { createApiHandler } from './api.js'
import type { DshContext, DshLlm, DshWorkspaceRegistry } from './dsh.js'
import { MailHarborRuntime } from './runtime.js'
import { registerMailTools } from './tools.js'

/** Loader row name shown by the DSH plugin manager. */
export const name = 'mailharbor'
/** Host services this plugin needs: the HTTP carrier and the tool registry. */
export const inject = ['webServer', 'tools']
export { VERSION } from './version.js'

const ROUTE = '/mail-plugin'

function optionalService<T>(ctx: DshContext, name: string): T | undefined {
  try {
    const direct = (ctx as unknown as Record<string, unknown>)[name]
    if (direct !== undefined && direct !== null) return direct as T
  } catch {
    // Guarded service access throws when the service is not injected.
  }
  try {
    return (ctx.get?.(name) as T | undefined) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * MailHarbor Host half: one HTTP prefix for the panel, plus `mail_*` agent
 * tools when the composition provides the tool registry.
 */
export function apply(ctx: DshContext): void {
  let registry: DshWorkspaceRegistry | undefined
  // The registry is optional: wait for it in the background instead of
  // blocking the whole plugin on compositions that do not mount workspaces.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], (scope: DshContext) => {
      try {
        registry = scope.workspaceRegistry
      } catch {
        registry = undefined
      }
    })
  }

  const runtime = new MailHarborRuntime({
    workspaceRegistry: () => registry,
    sessions: optionalService(ctx, 'sessions'),
    llm: () => {
      if (typeof ctx.get !== 'function') return undefined
      try {
        return ctx.get.call(ctx, 'llm') as DshLlm | undefined
      } catch {
        return undefined
      }
    },
  })

  // Warm the active account's IMAP session at startup, so the first server
  // mail open does not pay the TLS + LOGIN round trip.
  const activeAccount = runtime.current.accounts.find((item) => item.id === runtime.current.activeAccountId)
  if (activeAccount !== undefined && runtime.hasCredentials(activeAccount)) {
    void runtime
      .provider(activeAccount)
      .warm()
      .then(() => runtime.provider(activeAccount).list('INBOX', 40))
      .catch(() => undefined)
  }

  const handler = createApiHandler(runtime)
  const disposers: (() => void)[] = []
  if (activeAccount !== undefined) {
    setTimeout(() => runtime.startReferencesBackfill(activeAccount), 3000)
    setTimeout(() => void runtime.flushActions(activeAccount).catch(() => undefined), 6000)
  }

  const start = (): void => {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
    // `tools` is declared in `inject`; Cordis guarantees it is present here.
    if (ctx.tools !== undefined) disposers.push(...registerMailTools(ctx.tools, runtime))
  }

  const stop = (): void => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A disposer that already ran must not block the others.
      }
    }
    void runtime.dispose()
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      start()
      return stop
    }, 'mailharbor: routes and tools')
  } else {
    start()
  }
}
