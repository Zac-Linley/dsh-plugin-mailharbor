import { build, context } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const watch = process.argv.includes('--watch')

const hostExternal = ['imapflow', 'mailparser', 'nodemailer']

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  absWorkingDir: root,
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external: hostExternal,
  legalComments: 'none',
  logLevel: 'info',
}

/**
 * DSH loads a client plugin from one classic script that calls
 * `window.__ModuleLoader__.load({ id, factory })`, where `id` must equal the
 * package name. The factory receives `require` for the shared platform modules
 * and returns the module exports. esbuild emits the body as CommonJS, and this
 * wrapper supplies the `module`/`exports` pair the body expects.
 */
const clientBanner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`
const clientFooter = `
    return module.exports;
  },
});
`

/** @type {import('esbuild').BuildOptions} */
const clientOptions = {
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  sourcemap: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  jsx: 'transform',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  loader: { '.css': 'text' },
  define: { __MAILHARBOR_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: clientBanner },
  footer: { js: clientFooter },
  legalComments: 'none',
  logLevel: 'info',
}

await rm(resolve(root, 'lib'), { recursive: true, force: true })

if (watch) {
  const host = await context(hostOptions)
  const client = await context(clientOptions)
  await Promise.all([host.watch(), client.watch()])
  console.log(`[build] watching ${pkg.name}@${pkg.version} — lib/index.js, lib/client.js`)
} else {
  await Promise.all([build(hostOptions), build(clientOptions)])
  console.log(`[build] ${pkg.name}@${pkg.version} -> lib/index.js, lib/client.js`)
}
