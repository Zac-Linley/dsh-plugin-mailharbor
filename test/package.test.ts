import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  version: string
  main: string
  exports: Record<string, string>
  files: string[]
  engines: Record<string, string>
  dsh: {
    manifestVersion: number
    bundle: { patch: string }
    client: { platform: string; immediately?: boolean; inject?: string[] }
  }
  dependencies?: Record<string, string>
  publishConfig?: Record<string, string>
}

describe('package manifest', () => {
  it('declares the DSH loader contract', () => {
    expect(pkg.name).toBe('@zaclinley/dsh-mailharbor')
    expect(pkg.dsh.manifestVersion).toBe(1)
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-layout')
  })

  it('declares the version corridor DSH enforces', () => {
    expect(pkg.engines.dsh).toBe('>=0.2.2-0 <0.3.0')
    expect(pkg.engines.node).toBe('>=24.9.0')
  })

  it('points every export at a file', () => {
    expect(existsSync(join(root, pkg.main))).toBe(true)
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      expect(existsSync(join(root, target)), `export ${subpath} -> ${target}`).toBe(true)
    }
    expect(existsSync(join(root, pkg.dsh.bundle.patch))).toBe(true)
  })

  it('ships the bundle, patch layer and docs to npm', () => {
    for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
      expect(pkg.files).toContain(entry)
    }
  })

  it('has zero runtime dependency on DSH internals', () => {
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      expect(dependency.startsWith('@deepseek-ai/')).toBe(false)
    }
  })

  it('publishes publicly to the default registry', () => {
    expect(pkg.publishConfig?.access).toBe('public')
    expect(pkg.publishConfig?.registry).toBe('https://registry.npmjs.org/')
  })

  it('keeps the patch layer and the VERSION constants in sync', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain(pkg.name)
    for (const file of ['src/host/index.ts', 'src/client/index.tsx']) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source).toContain(`export const VERSION = '${pkg.version}'`)
    }
  })
})
