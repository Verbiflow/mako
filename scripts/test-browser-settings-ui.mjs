import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const { createServer } = await import('vite')
  const root = await mkdtemp(join(tmpdir(), 'mako-browser-settings-ui-'))
  const server = await createServer({ cacheDir: join(root, 'cache'), server: {host:'127.0.0.1',port:0} })
  await server.listen()
  await writeFile(join(root,'package.json'),JSON.stringify({main:fileURLToPath(import.meta.url)}))
  const env={...process.env,MAKO_BROWSER_SETTINGS_URL:server.resolvedUrls.local[0],MAKO_BROWSER_SETTINGS_ROOT:root}
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
  const root=process.env.MAKO_BROWSER_SETTINGS_ROOT
  app.setPath('userData',join(root,'profile'))
  await app.whenReady()
  const w=new BrowserWindow({show:false,width:760,height:920,webPreferences:{contextIsolation:true,nodeIntegration:false}})
  const page=w.webContents
  page.debugger.attach('1.3')
  const evaluate=s=>page.executeJavaScript(s)
  const until=async s=>{const end=Date.now()+15000;while(!await evaluate(s)){if(Date.now()>end)throw Error(s);await new Promise(r=>setTimeout(r,40))}}
  const click=async selector=>{const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mousePressed','mouseReleased'])await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})}
  const evidence=resolve('docs/audits/2026-09-22/browser-settings')
  await mkdir(evidence,{recursive:true})
  const capture=async name=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await writeFile(join(evidence,name),(await page.capturePage()).toPNG())}
  const timer=setTimeout(()=>app.exit(1),60000)
  try {
    await w.loadURL(process.env.MAKO_BROWSER_SETTINGS_URL+'scripts/browser-settings.html')
    await until("document.querySelectorAll('input[type=radio]').length===3")
    assert.equal(await evaluate("document.querySelector('input[value=aside]').checked"),true)
    assert.equal(await evaluate("document.querySelector('[data-browser-options]').open"),false)
    await until("[...document.images].every(i=>i.complete && i.naturalWidth>0)")
    assert.equal(await evaluate("document.body.innerText.includes('3de14b')"),false)
    assert.equal(await evaluate("document.body.innerText.includes('Work')"),true)
    assert.equal(await evaluate("document.querySelector('.activity-orb')===null"),true)
    await evaluate("(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');mcpStore.set({browsers:mcpStore.get().browsers.map(b=>b.id==='aside'?{...b,connection:{status:'connecting'}}:b)})})()")
    await until("document.querySelector('.activity-orb')!==null")
    await page.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await until("matchMedia('(prefers-reduced-motion: reduce)').matches")
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
    await new Promise(r=>setTimeout(r,500))
    const stillFrame=await evaluate("document.querySelector('.activity-orb').toDataURL()")
    await new Promise(r=>setTimeout(r,100))
    assert.equal(await evaluate("document.querySelector('.activity-orb').toDataURL()"),stillFrame)
    await capture('preparing.png')
    await page.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})
    await evaluate("(async()=>{const {mcp}=await import('/src/state/mcp.ts');await mcp.connectBrowser('aside')})()")
    await until("document.querySelector('.activity-orb')===null")
    await click('[data-browser-choice] button[aria-expanded]')
    assert.equal(await evaluate("document.querySelector('[data-browser-choice] button').getAttribute('aria-expanded')"),'true')
    assert.equal(await evaluate("document.querySelector('input[value=aside]').checked"),true)
    await evaluate("Promise.all(document.querySelector('[data-browser-choice]').getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))")
    await capture('aside-setup.png')
    await click('[data-browser-choice] button[aria-expanded]')
    await evaluate("Promise.all(document.querySelector('[data-browser-choice]').getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))")
    await capture('dark.png')
    await click('label:has(input[value=chrome])')
    await until("document.querySelector('input[value=chrome]').checked")
    assert.equal(await evaluate("document.querySelector('input[value=aside]').checked"),false)
    assert.equal(await evaluate("document.querySelector('[role=status]').innerText.includes('Browser access is off')"),true)
    await click('section > div:has([role=status]) button')
    await until("document.querySelector('[role=status]').innerText.includes('Ready for browser tasks')")
    await click('[data-browser-options] summary')
    await click('[data-browser-options] button:last-child')
    await until("document.querySelector('[role=status]').innerText.includes('Browser access is off')")
    await click('[data-browser-options] summary')
    await click('[data-browser-options] summary')
    await until("document.querySelector('[data-browser-options]').open")
    await capture('direct-expanded.png')
    await evaluate("document.documentElement.classList.add('light');document.documentElement.classList.remove('dark')")
    await capture('light.png')
    w.setSize(430,960)
    await capture('narrow.png')
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"),false)
    // Keyboard operates the native radio group, including clearing its selection.
    await evaluate("document.querySelector('input[value=aside]').focus()")
    await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32})
    await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32})
    await until("document.querySelector('input[value=aside]').checked")
    await evaluate("(async()=>{const {mcp}=await import('/src/state/mcp.ts');await mcp.preferBrowser(null)})()")
    assert.equal(await evaluate("Boolean(document.querySelector('input:checked'))"),false)
    await evaluate("(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');mcpStore.set({browsers:[]})})()")
    await capture('empty.png')
    console.log('PASS: production browser settings; pointer and keyboard selection; preference does not connect; enable/disable access; reduced-motion static frame; idle orb absent; direct disclosure; empty state; narrow layout; light/dark captures')
  } finally {clearTimeout(timer);w.destroy();app.quit()}
}
