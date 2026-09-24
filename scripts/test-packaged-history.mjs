import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { LiveJournal } from '../dist-electron/live-journal.js'
import { auditId, auditSnapshot } from './performance-audit-fixtures.ts'

// Actual packaged host/preload/UI with disposable retained journals; no provider
// is launched, and no installed profile or native store is modified.
const app = resolve(process.argv[2])
const retained = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : null
const proof = retained ? 'packaged-retained' : 'packaged'
const root = await mkdtemp(join(tmpdir(), 'mako-packaged-history-'))
const profile = join(root, 'profile')
const evidence = resolve('docs/audits/2026-09-23/live-history-performance')
await mkdir(evidence, { recursive: true })
const providers = ['claude', 'codex', 'cursor', 'grok', 'devin', 'opencode']
const cases = []
for (const [index, provider] of providers.entries()) {
  let source = auditSnapshot(300, provider, 150, 120 * 1024)
  if (retained) {
    const copy = retained[provider].copy
    const journal = new LiveJournal(dirname(copy), basename(copy, '.sqlite'))
    source = journal.read()
    journal.close()
    // Content-only copies cannot control or discover an original executor.
    source.threadPath = undefined
    source.control = undefined
    source.permissions = []
    if (source.base) source.base = { ...source.base, ref: { ...source.base.ref,
      nativeId: 'disposable-copy', path: join(root, `copy-${provider}`) } }
  }
  const id = auditId(30000 + index)
  source.session = { ...source.session, id, nativeId: undefined, threadPath: undefined, cwd: root,
    title: `Retained history — ${provider}`, status: 'ready', connection: 'disconnected' }
  source.requests.forEach(request => { request.status = 'completed' })
  const journal = new LiveJournal(join(profile, 'conversations'), id)
  journal.commit(source)
  journal.close()
  cases.push({ provider, id, bytes: Buffer.byteLength(JSON.stringify(source)),
    expectedBlocks: source.blocks.length - (source.baseCoveredBlocks ?? 0), expectedEntries: source.base?.entries.length ?? 0 })
}
const env = { ...process.env, MAKO_STANDALONE: '1', MAKO_DATA_ROOT: profile,
  MAKO_BACKEND_URL: 'http://127.0.0.1:9/api/mcp', MAKO_BACKEND_TOKEN: '', MAKO_CURSOR_SDK_ROOT: join(root, 'cursor') }
for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'MAKO_WEB_SOCKET', 'MAKO_HOST_ONLY', 'MAKO_WEB_ONLY']) delete env[key]
const child = spawn(join(app, 'Contents/MacOS/Mako'), [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
  { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-100000) })
let socket, sequence = 0
const pending = new Map()
const report = { app, root, kind: retained ? 'content-only copies of six real retained journals; no native execution' : 'six-provider retained-journal fixtures, no native execution', results: [] }
async function until(read, label) {
  const end = Date.now() + 60000
  while (Date.now() < end) {
    assert.equal(child.exitCode, null, `App exited during ${label}`)
    const value = await read()
    if (value) return value
    await delay(150)
  }
  throw new Error(`Timed out: ${label}`)
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 20000)
    pending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
  return value.result.value
}
async function capture(name) {
  await delay(350)
  const shot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, name), Buffer.from(shot.data, 'base64'))
}
try {
  const port = await until(async () => {
    const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
    return Number(text.split('\n')[0])
  }, 'debugger')
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('mako-app:')), 'renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.on('message', data => { const message = JSON.parse(data.toString()); const callback = pending.get(message.id); pending.delete(message.id); callback?.(message) })
  await until(() => evaluate('Boolean(window.mako && document.querySelector(".composer-input"))'), 'composer')
  for (const item of cases) {
    const selector = `[data-conversation-id="${item.id}"]`
    if (!await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))
      await evaluate(`(()=>{const first=document.querySelector('[data-conversation-id="${cases[0].id}"]');const section=first?.closest('section');Array.from(section?.querySelectorAll('button')??[]).find(b=>b.textContent.trim().startsWith('More'))?.click()})()`)
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `${item.provider} rail row`)
    const start = performance.now()
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await until(() => evaluate(`document.querySelector('.composer-input')?.getAttribute('placeholder')?.toLowerCase().includes(${JSON.stringify(item.provider)})`), `${item.provider} active composer`)
    await until(() => evaluate(retained ? `Boolean(document.querySelector('article'))` : `document.body.textContent.includes('Finding 299')`), `${item.provider} retained tail`)
    const openMs = performance.now() - start
    if (!retained) {
      await evaluate(`(()=>{const article=Array.from(document.querySelectorAll('article')).find(e=>e.textContent.includes('Finding 299'));const button=article?.querySelector('button[aria-expanded]');if(!button)throw Error('Missing tool row');button.click()})()`)
      await until(() => evaluate(`document.body.textContent.includes('Fixture output 299')`), `${item.provider} tool`)
    }
    const history = await evaluate(`(async()=>{
      async function read(input){let part=await window.mako.liveRead(${JSON.stringify(item.id)},input);let text=part.data;while(part.next!==null){part=await window.mako.liveRead(${JSON.stringify(item.id)},{kind:'part',record:part.record,offset:part.next});text+=part.data}return JSON.parse(text)}
      const first=await read({kind:'snapshot'});let pages=1,blocks=first.blocks.length,entries=first.base?.entries.length??0,page=first;
      while(page.history.before){page=await read({kind:'earlier',token:first.history.token,before:page.history.before});blocks+=page.blocks.length;entries+=page.base?.entries.length??0;pages++}
      const unchanged=await read({kind:'snapshot',epoch:first.epoch,ifCurrent:{token:first.history.token,revision:first.revision}});
      return {pages,blocks,entries,unchanged:unchanged.kind,tailBlocks:first.blocks.length};
    })()`)
    assert.equal(history.blocks, item.expectedBlocks)
    assert.equal(history.entries, item.expectedEntries)
    assert.equal(history.unchanged, 'unchanged')
    await capture(`${proof}-${item.provider}.png`)
    report.results.push({ ...item, openMs, ...history })
    console.log(`${item.provider}: complete ${history.blocks}-block/${history.entries}-entry history, ${history.pages} pages, UI visible, conditional refresh passed`)
  }
  report.rendererHeap = await command('Runtime.getHeapUsage')
  report.outcome = 'passed'
} catch (error) {
  report.outcome = 'failed'
  report.error = String(error)
  if (socket?.readyState === WebSocket.OPEN) { report.text = await evaluate('document.body.innerText'); await capture('packaged-failure.png') }
  throw error
} finally {
  await writeFile(join(evidence, `${proof}.json`), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(root, 'app.log'), logs)
  socket?.close()
  if (child.exitCode === null) {
    process.kill(-child.pid, 'SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)])
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* Disposable process group already exited. */ }
  }
}
