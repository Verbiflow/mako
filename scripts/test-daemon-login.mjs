import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Exercise the real registration flow against an isolated home and fake launchd.
const root = await mkdtemp(join(tmpdir(), 'mako-login-test-'))
const state = { root, packaged: true, loaded: false, calls: [] }
globalThis.__makoLoginTest = state
try {
  const mocks = {
    electron: `export const app = { get isPackaged() { return globalThis.__makoLoginTest.packaged }, getAppPath: () => globalThis.__makoLoginTest.root };`,
    'node:os': `export const homedir = () => globalThis.__makoLoginTest.root;`,
    'node:child_process': `export function execFile(command, args, cb) {
      const s = globalThis.__makoLoginTest; s.calls.push(args[0]);
      if (args[0] === 'bootstrap') s.loaded = true;
      if (args[0] === 'bootout') s.loaded = false;
      cb(args[0] === 'print' && !s.loaded ? new Error('not loaded') : null, 'pid = 123', '');
    }`,
    './build-identity.js': `export const buildTag = () => 'test-build';`,
    './headless-node.js': `export const headlessNodeExecutable = () => '/test/Mako Helper';`,
  }
  const outfile = join(root, 'login.mjs')
  await build({ entryPoints: ['electron/daemon-login.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
    define: { 'process.platform': '"darwin"' }, plugins: [{ name: 'isolated-login', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'fake' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }] })
  const login = await import(pathToFileURL(outfile).href)
  await mkdir(join(root, 'node_modules/@mako/sessions/dist'), { recursive: true })
  await writeFile(login.daemonScript(), '')
  await login.refreshDaemonLoginJob()
  assert.equal(state.loaded, true, 'first installed launch registers the daemon')
  assert.equal(await login.daemonLoginEnabled(), true)
  assert.match(await readFile(join(root, 'Library/LaunchAgents/com.mako.syncd.plist'), 'utf8'), /RunAtLoad/)
  const bootstraps = () => state.calls.filter(x => x === 'bootstrap').length
  const initial = bootstraps()
  await login.refreshDaemonLoginJob()
  assert.equal(bootstraps(), initial, 'unchanged loaded job is not restarted')
  state.loaded = false
  await login.refreshDaemonLoginJob()
  assert.equal(state.loaded, true, 'existing but unloaded registration is repaired')
  await login.setDaemonLogin(false)
  await login.refreshDaemonLoginJob()
  assert.equal(state.loaded, false, 'explicit opt-out persists across startup')
  assert.equal(await login.daemonLoginEnabled(), false)
  await rm(join(root, '.mako/syncd-login-optout'))
  state.packaged = false
  const before = state.calls.length
  await login.refreshDaemonLoginJob()
  assert.equal(state.calls.length, before, 'development checkout never registers a job')
  console.log('Daemon login: default-on, idempotent refresh, unloaded repair, opt-out, development isolation passed')
} finally {
  delete globalThis.__makoLoginTest
  await rm(root, { recursive: true, force: true })
}
