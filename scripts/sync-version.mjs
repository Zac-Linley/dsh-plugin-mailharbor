import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const targets = ['src/host/index.ts', 'src/client/index.tsx']
const version = `'${pkg.version}'`

for (const target of targets) {
  const file = resolve(root, target)
  const text = await readFile(file, 'utf8')
  const pattern = /export const VERSION = '([^']*)'/
  if (!pattern.test(text)) {
    throw new Error(`${target}: expected \`export const VERSION = '...'\``)
  }
  const next = text.replace(pattern, `export const VERSION = ${version}`)
  if (next !== text) await writeFile(file, next)
}

console.log(`[sync-version] ${pkg.name}@${pkg.version}`)
