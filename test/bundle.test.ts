// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => unknown
}

/** Execute lib/client.js the way the DSH shell does: register one factory. */
function loadClientBundle(): {
  module: { apply?: unknown; inject?: unknown; VERSION?: unknown }
  id: string
} {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const registrations: Registration[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      load: (registration: Registration) => {
        registrations.push(registration)
      },
    },
    __react: React,
    __reactDom: ReactDOM,
  }
  const run = new Function('window', 'document', 'self', code)
  run(fakeWindow, document, fakeWindow)
  expect(registrations).toHaveLength(1)
  const registration = registrations[0]
  if (registration === undefined) throw new Error('client bundle registered no module')
  const moduleExports = registration.factory((specifier: string) => {
    if (specifier === 'react') return fakeWindow.__react
    if (specifier === 'react-dom') return fakeWindow.__reactDom
    throw new Error(`unexpected module request: ${specifier}`)
  })
  return { module: moduleExports as { apply?: unknown; inject?: unknown }, id: registration.id }
}

// The bundle is built before this test runs (`npm run build` precedes `npm test`).

describe('built client bundle', () => {
  it('registers under the exact package name', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    const { id } = loadClientBundle()
    expect(id).toBe(pkg.name)
  })

  it('exports apply and the slots injection', () => {
    const { module } = loadClientBundle()
    expect(typeof module.apply).toBe('function')
    expect(module.inject).toEqual(['slots'])
  })

  it('registers the panel, sidebar entry and settings section', () => {
    const { module } = loadClientBundle()
    const registrations: { options: Record<string, unknown>; component: unknown }[] = []
    const injected: string[] = []
    const ctx = {
      slots: {
        inject(name: string, register: () => void) {
          injected.push(name)
          register()
        },
        register(options: Record<string, unknown>, component: unknown) {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    }
    ;(module.apply as (context: typeof ctx) => void)(ctx)
    expect(injected).toEqual(['main', 'settings.section', 'sidebar.panellist'])
    expect(registrations.map((entry) => entry.options.name)).toEqual([
      'main',
      'settings.section',
      'sidebar.panellist',
    ])
    expect(registrations[0]?.options.key).toBe('mailharbor')
    expect(registrations[1]?.options.id).toBe('mailharbor')
    expect(registrations[2]?.options.id).toBe('mailharbor')
    expect(registrations.every((entry) => typeof entry.component === 'function')).toBe(true)
  })
})

describe('built host bundle', () => {
  it('exports the loader contract', async () => {
    const module = (await import(join(root, 'lib', 'index.js'))) as {
      name?: string
      inject?: unknown
      apply?: unknown
    }
    expect(module.name).toBe('mailharbor')
    expect(module.inject).toEqual(['webServer'])
    expect(typeof module.apply).toBe('function')
  })

  it('mounts the HTTP prefix and the mail tools', async () => {
    const module = (await import(join(root, 'lib', 'index.js'))) as {
      apply: (ctx: unknown) => void
    }
    const routes: { kind: string; path: string }[] = []
    const tools: string[] = []
    let disposed = 0
    const ctx = {
      webServer: {
        register(route: { kind: string; path: string }) {
          routes.push(route)
          return () => {
            disposed += 1
          }
        },
      },
      tools: {
        register(definition: { name: string }) {
          tools.push(definition.name)
          return () => {
            disposed += 1
          }
        },
      },
      effect(run: () => () => void) {
        const stop = run()
        expect(typeof stop).toBe('function')
      },
    }
    module.apply(ctx)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/mail-plugin' })
    expect(typeof (routes[0] as { handler?: unknown }).handler).toBe('function')
    expect(tools).toEqual([
      'mail_status',
      'mail_list',
      'mail_read',
      'mail_search',
      'mail_drafts',
      'mail_draft',
      'mail_backup',
    ])
    expect(disposed).toBe(0)
  })
})
