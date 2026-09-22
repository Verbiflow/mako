import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const { createServer } = await import('vite')
  const root = await mkdtemp(join(tmpdir(), 'mako-recovery-ui-'))
  const server = await createServer({ cacheDir: join(root, 'cache'), server: {host:'127.0.0.1',port:0} })
  await server.listen()
  await writeFile(join(root,'package.json'),JSON.stringify({main:fileURLToPath(import.meta.url)}))
  const env={...process.env,MAKO_RECOVERY_URL:server.resolvedUrls.local[0],MAKO_RECOVERY_ROOT:root}
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child=spawn(resolve('node_modules/.bin/electron'),[root],{env,stdio:'inherit'})
    process.exitCode=await new Promise((r,j)=>{child.once('exit',r);child.once('error',j)})
  } finally { await server.close() }
} else {
  void checkWindow().catch(async error => { console.error(error); const {app}=await import('electron');app.exit(1) })
}

async function checkWindow() {
  const {app,BrowserWindow}=await import('electron')
  const root=process.env.MAKO_RECOVERY_ROOT
  app.setPath('userData',join(root,'profile'))
  await app.whenReady()
  const w=new BrowserWindow({show:false,width:1060,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}})
  const page=w.webContents
  page.debugger.attach('1.3')
  const evaluate=(s)=>page.executeJavaScript(s)
  const until=async(s)=>{const end=Date.now()+15000;while(!await evaluate(s)){if(Date.now()>end)throw Error(s);await new Promise(r=>setTimeout(r,40))}}
  const click=async(selector)=>{const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mousePressed','mouseReleased'])await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})}
  const seed=async(harness='codex',id='newest')=>evaluate(`(async()=>{const {acpStore}=await import('/src/state/acp-state.ts'); const {threadsStore}=await import('/src/state/thread-store.ts'); threadsStore.set({composerHarness:${JSON.stringify(harness)}}); const state=acpStore.get(); const live=state.conversations[state.activeKey]; acpStore.set({conversations:{...state.conversations,[state.activeKey]:{...live,harness:${JSON.stringify(harness)},session:{...live.session,harness:${JSON.stringify(harness)},status:'failed',connection:'disconnected',error:'Selected model is at capacity.'},requests:[{id:'earlier',status:'failed',failure:'network',text:'Check the earlier change.',attachments:[],error:'Connection ended.'},{id:${JSON.stringify(id)},status:'failed',failure:'rate-limited',text:'Review my changes and help resolve the merge.',attachments:[],error:'Selected model is at capacity. Please try a different model.'}],pendingPrompts:[],sending:false,permission:null}}});return true})()`)
  const evidence=resolve('docs/audits/2026-09-22/recovery-notice-ui')
  await mkdir(evidence,{recursive:true})
  const capture=async(name)=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await writeFile(join(evidence,name),(await page.capturePage()).toPNG())}
  const timer=setTimeout(()=>app.exit(1),90000)
  try {
    await w.loadURL(process.env.MAKO_RECOVERY_URL+'scripts/live-workflow.html')
    await until("Boolean(document.querySelector('.composer-input'))")
    await seed()
    await until("document.querySelectorAll('[data-recovery-notice]').length===1")
    assert.equal(await evaluate("document.querySelectorAll('[data-request-recovery]').length"),0)
    await capture('compact.png')
    await click('[data-recovery-notice] button[aria-expanded]')
    await until("Boolean(document.querySelector('[data-request-recovery=\"newest\"]'))")
    await capture('expanded.png')
    await click('[aria-label="Dismiss error"]')
    await until("!document.querySelector('[data-recovery-notice]')")
    await seed()
    assert.equal(await evaluate("Boolean(document.querySelector('[data-recovery-notice]'))"),false)
    await w.loadURL(process.env.MAKO_RECOVERY_URL+'scripts/live-workflow.html')
    await until("Boolean(document.querySelector('.composer-input'))")
    await seed()
    await new Promise(r=>setTimeout(r,150))
    assert.equal(await evaluate("Boolean(document.querySelector('[data-recovery-notice]'))"),false)
    await capture('dismissed-after-reload.png')
    assert.equal(await evaluate("(async()=>{const {acpStore}=await import('/src/state/acp-state.ts');const s=acpStore.get();return s.conversations[s.activeKey].requests.length})()"),2)
    await click('[aria-label="Conversation actions"]')
    await until("[...document.querySelectorAll('summary')].some(n=>n.textContent.includes('Saved messages (2)'))")
    await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    for(const harness of ['claude','codex','cursor','grok','devin','opencode']) {
      await seed(harness,'new-'+harness)
      await until("Boolean(document.querySelector('[data-recovery-notice]'))")
      assert.equal(await evaluate("document.querySelectorAll('[data-recovery-notice]').length"),1)
    }
    await evaluate("document.querySelector('aside[aria-label=\"Agents companion\"]').style.display='none'")
    await w.setSize(430,800)
    await new Promise(r=>setTimeout(r,150))
    assert.ok(await evaluate("document.querySelector('[data-recovery-notice]').getBoundingClientRect().width > 350"))
    await capture('narrow.png')
    await evaluate("(async()=>{const {acpStore}=await import('/src/state/acp-state.ts');const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,requests:[...l.requests,{id:'resolved',status:'completed',text:'A later successful turn',attachments:[]}]}}});return true})()")
    await until("!document.querySelector('[data-recovery-notice]')")
    console.log('PASS: one compact notice; details; persistent dismissal after reload; new failures visible; all-six provider fixtures; narrow screenshot')
    console.log('Visual evidence: '+evidence)
  } finally {clearTimeout(timer);w.destroy();app.quit()}
}
