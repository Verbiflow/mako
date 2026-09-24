import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

async function check() {
app.setPath('userData', join(process.env.MAKO_HISTORY_ROOT, 'browser'))
await app.whenReady()
const window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false } })
const page = window.webContents
const evaluate = code => page.executeJavaScript(code)
const until = async code => {
  const end = Date.now() + 20000
  while (!await evaluate(code)) { assert.ok(Date.now() < end, code); await new Promise(resolve => setTimeout(resolve, 40)) }
}
const evidence = resolve('docs/audits/2026-09-23/live-history-paging')
await mkdir(evidence, { recursive: true })
const capture = async name => {
  window.showInactive()
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  // Chromium may have committed DOM/layout before its visible compositor has
  // presented that frame. Capture the settled frame, not the previous fixture.
  await new Promise(resolve => setTimeout(resolve, 350))
  await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
}
const deadline = setTimeout(() => app.exit(1), 90000)
try {
  await window.loadURL(process.env.MAKO_HISTORY_URL + 'scripts/live-workflow.html')
  await until("Boolean(document.querySelector('.composer-input'))")
  await evaluate(`(async () => {
    const original = window.mako;
    const { installWebBridge } = await import('/src/dev/web-bridge.ts');
    await installWebBridge(); const real = window.mako;
    // Only workspace/provider discovery is a fixture. All history calls use
    // the production web bridge, proxy, peer router and owner reader.
    window.mako = { ...original, liveRead: real.liveRead, liveSnapshot: real.liveSnapshot, copy: async text => { window.copiedHistory = text } };
    const { hydrateLive, applyLiveBatch } = await import('/src/state/live-recovery.ts');
    real.onEvent(event => { if(event.type === 'live-batch') applyLiveBatch(event.batch) });
    const { acpStore } = await import('/src/state/acp-state.ts');
    window.historyState = () => acpStore.get().conversations[${JSON.stringify(process.env.MAKO_HISTORY_ID)}];
    await hydrateLive(${JSON.stringify(process.env.MAKO_HISTORY_ID)});
    acpStore.set({activeKey:${JSON.stringify(process.env.MAKO_HISTORY_ID)}});
  })()`)
  await until("document.body.textContent.includes('Finding 299')")
  assert.ok(await evaluate('historyState().blocks.length < 100'))
  assert.equal(await evaluate("document.querySelectorAll('[data-sonner-toast]').length"), 0)
  await capture('recent-history.png')

  // A real scroll gesture reaches the earlier-history edge. Paging is owned
  // by the existing timeline, not a test-only Load button.
  const before = await evaluate('historyState().history.blockStart')
  await evaluate("document.querySelector('.scroll-fade-scroller').scrollTop = 10")
  const point = await evaluate("(()=>{const r=document.querySelector('.scroll-fade-scroller').getBoundingClientRect();return {x:Math.round(r.left+200),y:Math.round(r.top+150)}})()")
  page.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: 500, deltaX: 0, canScroll: true })
  await until(`historyState().history.blockStart < ${before}`)
  assert.ok(await evaluate('historyState().blocks.length > 80'))
  await capture('earlier-history.png')

  await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Jump to latest'))?.click()")
  await until("(()=>{const s=document.querySelector('.scroll-fade-scroller');return s.scrollHeight-s.scrollTop-s.clientHeight<5})()")
  await until("Array.from(document.querySelectorAll('article')).some(e=>e.textContent.includes('Finding 299'))")
  await evaluate(`(()=>{
    const article=Array.from(document.querySelectorAll('article')).find(e=>e.textContent.includes('Finding 299'));
    const button=article?.querySelector('button[aria-expanded]');
    if(!button)throw Error('Tool row missing');button.click();
  })()`)
  await until("historyState().blocks.some(b=>b.type==='tool' && b.id==='tool-299' && !b.historyRest && b.output.length>120000)")
  await until("document.body.textContent.includes('Fixture output 299')")
  await evaluate("Array.from(document.querySelectorAll('article')).find(e=>e.textContent.includes('Finding 299')).scrollIntoView({block:'start',behavior:'instant'})")
  await capture('complete-tool-output.png')
  await evaluate(`(()=>{const article=Array.from(document.querySelectorAll('article')).find(e=>e.textContent.includes('Finding 299'));article.querySelector('[aria-label="Copy answer"]').click()})()`)
  await until("window.copiedHistory?.includes('Finding 299')")
  assert.equal(await evaluate("document.querySelectorAll('[data-sonner-toast]').length"), 0)
  console.log('PASS: production UI opens >32 MiB history through browser/forwarded owner, scrolls to earlier content, reads complete tool output, copies answer, no restart/error notice')
  console.log('Visual evidence: ' + evidence)
} catch (error) {
  console.error(error)
  await capture('failure.png')
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  window.destroy()
  app.exit(process.exitCode ?? 0)
}

}
void check().catch(error => { console.error(error); app.exit(1) })
