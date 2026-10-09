import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { extractFile } from '@electron/asar'
import { LiveJournal } from '../dist-electron/live-journal.js'
import { providerHost } from '../dist-electron/providers/index.js'
import { auditId, auditSnapshot } from './performance-audit-fixtures.ts'
import { PackagedApp } from './lib/packaged-app.mjs'

// Actual packaged host/preload/UI with disposable retained journals; no provider
// is launched, and no installed profile or native store is modified.
const app = resolve(process.argv[2])
const retained = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : null
const installed = app === '/Applications/Mako.app'
const proof = `${installed ? 'installed' : 'packaged'}${retained ? '-retained' : ''}`
const root = await mkdtemp(join(tmpdir(), 'mako-packaged-history-'))
const profile = join(root, 'profile')
const evidence = resolve(process.env.MAKO_HISTORY_EVIDENCE_DIR ?? 'docs/audits/2026-09-23/live-history-performance')
await mkdir(evidence, { recursive: true })
const providers = providerHost.harnesses.list().map(({ provider }) => provider)
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
let logs = ''
const pkg = new PackagedApp({ executable: join(app, 'Contents/MacOS/Mako'), root, workspace: root,
  onStdoutLine: line => { logs = (logs + line + '\n').slice(-100000) } })
const report = { app, root, kind: retained ? 'content-only copies of six real retained journals; no native execution' : 'six-provider retained-journal fixtures, no native execution', results: [] }
report.build = JSON.parse(extractFile(join(app, 'Contents/Resources/app.asar'), 'package.json').toString()).makoBuild
const until = (read, label) => pkg.waitFor(read, Boolean, label, 60000)
const command = (method, params) => pkg.command(method, params)
const evaluate = expression => pkg.evaluate(expression)
async function capture(name) {
  await delay(350)
  const shot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(evidence, name), Buffer.from(shot.data, 'base64'))
}
async function selectConversation(item) {
  const selector = `[data-conversation-id="${item.id}"]`
  if (!await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
    // Reload restores the collapsed group. Its first fixture may itself be
    // hidden, so find the group through any currently rendered fixture row.
    const siblings = cases.map(entry => `[data-conversation-id="${entry.id}"]`).join(',')
    await evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(siblings)});const section=row?.closest('section');Array.from(section?.querySelectorAll('button')??[]).find(b=>b.textContent.trim().startsWith('More'))?.click()})()`)
  }
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `${item.provider} rail row`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await until(() => evaluate(`document.querySelector('.composer-input')?.getAttribute('placeholder')?.toLowerCase().includes(${JSON.stringify(item.provider)})`), `${item.provider} active composer`)
}
async function checkReadingAndDraft(item) {
  await command('Page.bringToFront')
  await until(() => evaluate('document.hasFocus()'), `${item.provider} focused verification window`)
  const first = await evaluate(`document.querySelector('[data-exchange]')?.textContent.slice(0,300)`)
  const scroll = await evaluate(`(()=>{const s=[...document.querySelectorAll('.scroll-fade-scroller')].find(s=>s.querySelector('[data-exchange]'));s.scrollTop=1;const r=s.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+100}})()`)
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scroll, deltaX: 0, deltaY: -650 })
  if (item.expectedBlocks + item.expectedEntries > 80)
    await until(() => evaluate(`document.querySelector('[data-exchange]')?.textContent.slice(0,300) !== ${JSON.stringify(first)}`), `${item.provider} earlier content after scrolling`)
  await capture(`${proof}-${item.provider}-earlier.png`)
  await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Jump to latest'));button?.click()})()`)
  await delay(350)
  // Jump releases paging but enables tail following. A real upward wheel
  // exits follow mode before tool expansion changes the transcript's height.
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scroll, deltaX: 0, deltaY: -100 })
  await delay(300)
  const toolSelector = '[class~="group/tool"] button[aria-expanded]'
  // Use visible controls, like a reader. Hidden logs retain mounted rows and
  // virtualized rows can disappear if automation scrolls a stale node into view.
  const findControl = `(()=>{const visible=b=>{const r=b.getBoundingClientRect();return r.width>0 && r.height>0 && b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};const tools=[...document.querySelectorAll(${JSON.stringify(toolSelector)})];const tool=tools.find(visible);const b=tool??[...document.querySelectorAll('button[data-work-summary][aria-expanded="false"]')].find(visible);if(!b)return null;const r=b.getBoundingClientRect();if(tool)window.proofTool=tool;return{x:r.left+r.width/2,y:r.top+r.height/2,tool:Boolean(tool),expanded:b.getAttribute('aria-expanded')}})()`
  let control
  for (let n = 0; n < 12; n++) {
    control = await evaluate(findControl)
    if (control) {
      if (control.expanded !== 'true') {
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: control.x, y: control.y, button: 'left', clickCount: 1 })
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: control.x, y: control.y, button: 'left', clickCount: 1 })
      }
      await delay(150)
      if (control.tool && await evaluate("window.proofTool?.getAttribute('aria-expanded') === 'true'")) break
    } else {
      await command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scroll, deltaX: 0, deltaY: -400 })
    }
    await delay(350)
  }
  assert.ok(control?.tool, `${item.provider}: a visible actual tool row is available`)
  await until(() => evaluate(`(()=>{const b=window.proofTool;const panel=b?.parentElement?.parentElement;return b?.isConnected && b.getAttribute('aria-expanded')==='true' && panel.querySelector('[data-tool-body]') && !panel.textContent.includes('Reading the rest of this output')})()`), `${item.provider} expanded tool`)
  assert.equal(await evaluate(`Boolean(document.querySelector('[role="alert"]'))`), false, 'No tool read error')
  await delay(350)
  await evaluate(`window.proofTool.scrollIntoView({block:'center',behavior:'instant'})`)
  await until(() => evaluate(`(()=>{const b=window.proofTool;const r=b.getBoundingClientRect();return b.isConnected && r.width>0 && r.height>0 && b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`), `${item.provider} expanded tool visibly exposed`)
  await capture(`${proof}-${item.provider}-tool.png`)
  const draft = `History verification ${item.provider} — unsent`
  await evaluate(`document.querySelector('.composer-input').focus()`)
  await command('Input.insertText', { text: draft })
  await until(() => evaluate(`document.querySelector('.composer-input')?.value === ${JSON.stringify(draft)} && localStorage.getItem('mako.session-drafts.v1')?.includes(${JSON.stringify(draft)})`), `${item.provider} durable draft`)
  await selectConversation(cases[(cases.indexOf(item) + 1) % cases.length])
  await selectConversation(item)
  assert.equal(await evaluate(`document.querySelector('.composer-input').value`), draft, 'Switching away/back preserves the draft')
  const origin = await evaluate('performance.timeOrigin')
  await evaluate(`(()=>{const button=document.querySelector('button[aria-label="Reload UI"]');if(!button)throw Error('Reload UI control missing');button.click()})()`)
  await until(() => evaluate(`performance.timeOrigin !== ${origin} && document.querySelector('.composer-input')?.value === ${JSON.stringify(draft)}`).catch(() => false), `${item.provider} draft after reload`)
  const rawOrigin = await evaluate('performance.timeOrigin')
  await command('Page.reload')
  await until(() => evaluate(`performance.timeOrigin !== ${rawOrigin} && document.querySelector('.composer-input')?.value === ${JSON.stringify(draft)}`).catch(() => false), `${item.provider} selection and draft after raw reload`)
  await capture(`${proof}-${item.provider}-draft.png`)
  await evaluate(`document.querySelector('.composer-input').focus(); document.querySelector('.composer-input').select()`)
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await until(() => evaluate(`document.querySelector('.composer-input')?.value === ''`), `${item.provider} verification draft removed`)
  assert.equal(await evaluate(`document.querySelectorAll('[data-sonner-toast]').length`), 0, 'No restore notice storm')
  return { earlierContent: item.expectedBlocks + item.expectedEntries > 80 ? 'scroll verified' : 'complete history already loaded', toolExpanded: true, draftSwitch: true, draftReload: true, rawReload: true, draftRemoved: true }
}
try {
  await pkg.start()
  for (const item of cases) {
    const start = performance.now()
    await selectConversation(item)
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
    const interaction = await checkReadingAndDraft(item)
    await capture(`${proof}-${item.provider}.png`)
    report.results.push({ ...item, openMs, ...history, interaction })
    console.log(`${item.provider}: complete ${history.blocks}-block/${history.entries}-entry history, ${history.pages} pages, UI visible, conditional refresh passed`)
  }
  report.rendererHeap = await command('Runtime.getHeapUsage')
  report.outcome = 'passed'
} catch (error) {
  report.outcome = 'failed'
  report.error = String(error)
  if (pkg.socket?.readyState === WebSocket.OPEN) {
    report.text = await evaluate('document.body.innerText')
    report.tool = await evaluate(`(()=>{const b=window.proofTool;if(!b)return null;const r=b.getBoundingClientRect();return{connected:b.isConnected,rect:r.toJSON(),expanded:b.getAttribute('aria-expanded'),hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,1000)}})()`)
    await capture(`${proof}-failure.png`)
  }
  throw error
} finally {
  await writeFile(join(evidence, `${proof}.json`), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(root, 'app.log'), logs)
  await pkg.stop()
}
