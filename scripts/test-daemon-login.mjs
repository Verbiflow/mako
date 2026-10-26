import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Exercise the real registration flow against an isolated home and fake launchd.
const root = await mkdtemp(join(tmpdir(), 'mako-login-test-'))
const state = { root, packaged: true, loaded: false, calls: [], logs: [], print: null }
globalThis.__makoLoginTest = state
try {
  const mocks = {
    'node:os': `export const homedir = () => globalThis.__makoLoginTest.root; export const release = () => '25.0.0';`,
    'node:child_process': `export function execFile(command, args, cb) {
      const s = globalThis.__makoLoginTest; s.calls.push(args[0]);
      if (args[0] === 'bootstrap') s.loaded = true;
      if (args[0] === 'bootout') s.loaded = false;
      // As promisify reads the real execFile: one value holding both streams.
      cb(args[0] === 'print' && !s.loaded ? new Error('not loaded') : null, { stdout: args[0] === 'print' && s.print ? s.print : 'pid = 123', stderr: '' });
    }`,
    '../base/host-log.js': `export const hostLog = (...line) => globalThis.__makoLoginTest.logs.push(line);`,
    '../base/headless-node.js': `export const headlessNodeExecutable = () => '/test/Mako Helper';`,
  }
  const outfile = join(root, 'login.mjs')
  await build({ entryPoints: ['packages/host/src/threads/daemon-login.ts'], bundle: true, platform: 'node', format: 'esm', outfile,
    define: { 'process.platform': '"darwin"' }, plugins: [{ name: 'isolated-login', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'fake' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }] })
  const login = await import(pathToFileURL(outfile).href)
  const app = { appRoot: root, version: '0.0.1', build: {}, isolated: false, get packaged() { return state.packaged } }
  await mkdir(join(root, 'node_modules/@mako/sessions/dist'), { recursive: true })
  await writeFile(login.daemonScript(app), '')
  await login.refreshDaemonLoginJob(app)
  assert.equal(state.loaded, true, 'first installed launch registers the daemon')
  assert.equal(await login.daemonLoginEnabled(), true)
  assert.match(await readFile(join(root, 'Library/LaunchAgents/com.mako.syncd.plist'), 'utf8'), /RunAtLoad/)
  const bootstraps = () => state.calls.filter(x => x === 'bootstrap').length
  const initial = bootstraps()
  await login.refreshDaemonLoginJob(app)
  assert.equal(bootstraps(), initial, 'unchanged loaded job is not restarted')
  state.loaded = false
  await login.refreshDaemonLoginJob(app)
  assert.equal(state.loaded, true, 'existing but unloaded registration is repaired')
  await login.setDaemonLogin(app, false)
  await login.refreshDaemonLoginJob(app)
  assert.equal(state.loaded, false, 'explicit opt-out persists across startup')
  assert.equal(await login.daemonLoginEnabled(), false)
  await rm(join(root, '.mako/syncd-login-optout'))
  state.packaged = false
  const before = state.calls.length
  await login.refreshDaemonLoginJob(app)
  assert.equal(state.calls.length, before, 'development checkout never registers a job')
  // A packaged build isolated in a data root of its own (a proof's) never takes over the person's login sync, nor opts them out.
  const isolated = { ...app, packaged: true, isolated: true }
  await login.refreshDaemonLoginJob(isolated)
  assert.equal(state.calls.length, before, 'an isolated packaged build never registers a job')
  await assert.rejects(login.setDaemonLogin(isolated, false), /keeps its data apart/)
  await assert.rejects(readFile(join(root, '.mako/syncd-login-optout')), 'nor writes the opt-out')

  // A job another build left loaded (launchd keeps it alive, so retiring its daemon only restarts it) is
  // unloaded, and this app's own job is installed in its place; the person's own job is left alone.
  const printed = (program, args, version) => `gui/501/com.mako.syncd = {\n\tactive count = 1\n\tpath = /deleted/home/Library/LaunchAgents/com.mako.syncd.plist\n\tstate = running\n\n\tprogram = ${program}\n\targuments = {\n${args.map((arg) => `\t\t${arg}\n`).join('')}\t}\n\n\tinherited environment = {\n\t\tSSH_AUTH_SOCK => /tmp/socket\n\t}\n\n\tenvironment = {\n\t\tELECTRON_RUN_AS_NODE => 1\n\t\tMAKO_DAEMON_VERSION => ${version}\n\t}\n\n\tpid = 456\n\tproperties = runatload | inferred program\n}\n`
  const foreign = printed('/private/tmp/scratch/Mako.app/Contents/Frameworks/Mako Helper.app/Contents/MacOS/Mako Helper', ['/private/tmp/scratch/Mako.app/Contents/Frameworks/Mako Helper.app/Contents/MacOS/Mako Helper', '/private/tmp/scratch/Mako.app/Contents/Resources/app.asar/node_modules/@mako/sessions/dist/daemon-main.js'], '0.0.9+scratch')
  state.packaged = true
  state.loaded = true
  state.print = foreign
  state.logs.length = 0
  const plist = join(root, 'Library/LaunchAgents/com.mako.syncd.plist')
  await rm(plist, { force: true })
  let mark = state.calls.length
  await login.refreshDaemonLoginJob(app)
  assert.deepEqual(state.calls.slice(mark).filter((call) => call !== 'print'), ['bootout', 'bootout', 'bootstrap'], 'the foreign job is unloaded, then this app installs its own')
  assert.equal(state.logs.length, 1, 'said once')
  assert.match(String(state.logs[0][1]), /another build's login sync was unloaded/)
  assert.equal(state.logs[0][2].differs, 'program,script,version')
  const own = await readFile(plist, 'utf8')
  const ownArgs = [...own.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
  const ownVersion = /MAKO_DAEMON_VERSION<\/key><string>([^<]+)</.exec(own)[1]
  // This app's own job, shown whole by launchd, is never touched.
  state.print = printed('/test/Mako Helper', ownArgs.filter((arg) => arg.startsWith('/') || arg.startsWith('--')), ownVersion)
  state.logs.length = 0
  mark = state.calls.length
  await login.refreshDaemonLoginJob(app)
  assert.deepEqual(state.calls.slice(mark).filter((call) => call !== 'print'), [], 'its own job stays as it is')
  assert.equal(state.logs.length, 0)
  // Opted out: the foreign job and a foreign plist at this app's path go, and nothing is installed.
  await login.setDaemonLogin(app, false)
  await writeFile(plist, '<plist>another build</plist>')
  state.loaded = true
  state.print = foreign
  mark = state.calls.length
  await login.refreshDaemonLoginJob(app)
  assert.deepEqual(state.calls.slice(mark).filter((call) => call !== 'print'), ['bootout'], 'unloaded, and the opt-out keeps this app from installing its own')
  await assert.rejects(readFile(plist), 'its plist would load it again at the next login')
  assert.equal(await login.daemonLoginEnabled(), false)
  console.log('Daemon login: default-on, idempotent refresh, unloaded repair, opt-out, development and isolated builds, and a foreign job unloaded passed')
} finally {
  delete globalThis.__makoLoginTest
  await rm(root, { recursive: true, force: true })
}
