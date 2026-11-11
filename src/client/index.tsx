import styles from './styles.css'
import { MailIcon } from './icon.js'
import { MailPanel } from './panel.js'
import { MailSettings } from './settings.js'
import { TasksIcon, TasksPanel } from './tasks-panel.js'
import type { ClientContext } from './dsh.js'

/** Keep in sync with package.json (`npm run version` does this). */
export const VERSION = '0.15.0'

/** Services required by this browser plugin. */
export const inject = ['slots']

const PANEL_ID = 'mailharbor'
const TASKS_PANEL_ID = 'mailharbor-tasks'
const STYLE_ID = 'mailharbor-style'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = styles
  document.head.append(element)
}

/**
 * MailHarbor browser half: a sidebar panel, the panel page in the main slot,
 * and a settings section. All three read the same same-origin HTTP API.
 */
export function apply(ctx: ClientContext): void {
  ensureStyles()
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MailPanel))
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: PANEL_ID,
        order: 35,
        label: () => 'MailHarbor',
      },
      MailSettings,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: 'MailHarbor',
      },
      MailIcon,
    ),
  )
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: TASKS_PANEL_ID }, TasksPanel))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: TASKS_PANEL_ID,
        order: 21,
        label: '任务',
      },
      TasksIcon,
    ),
  )
}

export { PANEL_ID, TASKS_PANEL_ID }
