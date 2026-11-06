import { createApiHandler } from './api.js'
import type { DshContext } from './dsh.js'
import { MailHarborRuntime } from './runtime.js'
import { registerMailTools } from './tools.js'

/** Loader row name shown by the DSH plugin manager. */
export const name = 'mailharbor'
/** Host services this plugin needs: the HTTP carrier and the tool registry. */
export const inject = ['webServer', 'tools']
/** Keep in sync with package.json (`npm run version` does this). */
export const VERSION = '0.2.0'

const ROUTE = '/mail-plugin'

/**
 * MailHarbor Host half: one HTTP prefix for the panel, plus `mail_*` agent
 * tools when the composition provides the tool registry.
 */
export function apply(ctx: DshContext): void {
  const runtime = new MailHarborRuntime()
  const handler = createApiHandler(runtime)
  const disposers: (() => void)[] = []

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
