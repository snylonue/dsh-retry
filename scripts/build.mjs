/**
 * Build the browser half of `dsh-retry-button`.
 *
 * The Web client does not load an ES module for a plugin. It loads a script
 * that calls `window.__ModuleLoader__.load({ id, factory })`, where `factory`
 * receives a `require` resolving against the shell's frozen module table
 * (`react`, `react/jsx-runtime`, ...) and returns the plugin's exports.
 *
 * So this script does two things:
 *
 * 1. Bundle `src/client.tsx` to CommonJS with esbuild, keeping the baseline
 *    modules and DSH client packages external so the browser resolves the
 *    host's single instances rather than bundling duplicates. React in
 *    particular MUST stay external: a second copy would break hooks.
 * 2. Wrap that output in the loader envelope.
 *
 * Wrapping is valid because esbuild's CJS output assigns to `module.exports`
 * and never declares `module` or `exports` itself, so the envelope's own
 * bindings are exactly what the bundle writes to.
 *
 * @module build
 */

import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Package id registered with the module loader; must equal the package name. */
const ID = pkg.name

/**
 * Modules resolved from the shell's frozen table at runtime.
 *
 * These are the Web client baseline plus this plugin's declared
 * `dsh.client.external` requests. Everything else is bundled.
 */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm',
]

const outdir = join(root, 'lib')
// Clean only the bundle directory, which this script solely owns. `dist/` is
// tsc's output, produced by the earlier step of `pnpm run build`; deleting it
// here would discard the compilation that just ran.
rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

const result = await build({
  entryPoints: [join(root, 'src/client.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNAL,
  write: false,
  logLevel: 'info',
})

const body = result.outputFiles[0]?.text
if (body === undefined) throw new Error('build: esbuild produced no output')

/** Indent one block so the emitted envelope stays readable. */
const indent = (text) => text.replace(/^(?=.)/gm, '\t\t').replace(/\s+$/, '')

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${indent(body)}
\t\treturn module.exports;
\t}
});
`

const target = join(outdir, 'client.js')
writeFileSync(target, wrapped)

/**
 * Assert every path the package manifest promises actually exists.
 *
 * The host activates this package by importing its `main` export and serving
 * `exports["./client"]`. A published tarball missing either one fails at
 * activation with "failed to import", far from the build that caused it — so
 * the build refuses to report success unless both are present on disk.
 */
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const promised = [
  ['main', manifest.main],
  ['exports["."]', manifest.exports?.['.']?.default],
  ['exports["./client"]', manifest.exports?.['./client']?.default],
  ['dsh.bundle.patch', manifest.dsh?.bundle?.patch],
]
const missing = promised
  .filter(([, rel]) => typeof rel !== 'string')
  .map(([label]) => `${label} is not declared`)
for (const [label, rel] of promised) {
  if (typeof rel !== 'string') continue
  if (!existsSync(join(root, rel))) missing.push(`${label} -> ${rel}`)
}
if (missing.length > 0) {
  throw new Error(`build: manifest entries missing after build:\n  ${missing.join('\n  ')}`)
}

console.log(`built ${target} (${wrapped.length} bytes)`)
console.log(`verified ${promised.length} manifest entries`)

/**
 * Structural check on the client declaration.
 *
 * `dsh.client.inject` names packages whose client bundles must load before this
 * one. The composition rejects a request with no supplier, and the browser
 * reports the failure only as `web boot: ... did not activate` — far from the
 * build that caused it. Two rules follow from how the shell composes bundles:
 *
 * 1. Never inject a **baseline** module. React, Cordis, `dsh-client-store`,
 *    `dsh-client-ui-slots`, `dsh-client-ui-primitives` and
 *    `dsh-client-ui-dockkit` are seeded into the frozen module table by the
 *    shell; they are not graph rows, so naming one asks for a supplier that
 *    cannot exist. This is why the shipped UI plugins inject
 *    `dsh-client-ui-renderer` (which declares `ctx.slots`) rather than the
 *    slots package itself.
 * 2. Inject only packages that ship a client half, and keep every runtime
 *    import satisfied by either an injection or the baseline table.
 */
const BASELINE_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const injected = pkg.dsh?.client?.inject ?? []
const baselineInjected = injected.filter((id) => BASELINE_MODULES.has(id))
if (baselineInjected.length > 0) {
  throw new Error(
    `build: dsh.client.inject must not name baseline modules (they are not graph rows):\n  ${baselineInjected.join('\n  ')}`,
  )
}