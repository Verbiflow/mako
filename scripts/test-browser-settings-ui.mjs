import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testScratch } from "./lib/test-scratch.mjs"

if (!process.versions.electron) {
  const { createServer } = await import('vite')
  const root = testScratch('mako-browser-settings-ui-')
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
  const evidence=resolve('docs/audits/2026-09-22/browser-settings-repair')
  await mkdir(evidence,{recursive:true})
  const capture=async name=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await writeFile(join(evidence,name),(await page.capturePage()).toPNG())}
  const timer=setTimeout(()=>app.exit(1),60000)
  try {
    await w.loadURL(process.env.MAKO_BROWSER_SETTINGS_URL+'scripts/browser-settings.html')
    await until("document.querySelectorAll('input[type=radio]').length===2")
    assert.equal(await evaluate("document.querySelector('input[value=aside]').checked"),true)
    assert.equal(await evaluate("document.querySelector('input[value=mako]')===null"),true)
    assert.equal(await evaluate("document.body.innerText.includes('Unnamed profile')"),false)
    assert.equal(await evaluate("document.body.innerText.includes('unsigned build')"),false)
    assert.equal(await evaluate("document.body.innerText.includes('Mako can read the screen')"),true)
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
    // The orb draws on a canvas its worker holds, which the page can't read back: what it shows is what the window shows there.
    const orbShown=async()=>{const box=await evaluate("(()=>{const b=document.querySelector('.activity-orb').getBoundingClientRect();return {x:Math.floor(b.x),y:Math.floor(b.y),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()");assert.ok(box.width>0&&box.height>0,'the orb has a size');return (await page.capturePage(box)).toPNG().toString('base64')}
    const stillFrame=await orbShown()
    await new Promise(r=>setTimeout(r,300))
    assert.equal(await orbShown(),stillFrame,'the orb is still under reduced motion')
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
    assert.equal(await evaluate("document.querySelector('[role=status]').innerText.includes('Open Chrome')"),true)
    await click('section[aria-label="Browser use"] > div:has([role=status]) button')
    await until("document.querySelector('input[aria-label=\"Browser extension folder\"]')!==null")
    assert.equal(await evaluate("document.querySelector('[role=status]').innerText.includes('Open Chrome')"),true)
    await capture('chrome-setup.png')
    await evaluate("(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');mcpStore.set({browserSetup:undefined,browsers:mcpStore.get().browsers.map(b=>b.id==='chrome'?{...b,profileName:'Ana',connection:{status:'disconnected'}}:b)})})()")
    await click('section[aria-label="Browser use"] > div:has([role=status]) button')
    await until("document.querySelector('[role=status]').innerText.includes('Ready for browser tasks')")
    await click('section[aria-label="Browser use"] > div:has([role=status]) button')
    await until("document.querySelector('[role=status]').innerText.includes('Not connected')")
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
    // A Linux desktop's own asks under Computer use: each state says one thing and offers its one action.
    const desktopRows=()=>evaluate("[...document.querySelectorAll('ul[aria-label=\"This desktop\"] li')].map(row=>({title:row.querySelector('h4').innerText,text:row.querySelector('p').innerText,buttons:[...row.querySelectorAll('button')].map(b=>b.innerText),status:[...row.querySelectorAll('span')].map(s=>s.innerText).filter(Boolean)}))")
    const linux=(desktop,pending)=>({supported:true,persistentAcrossUpdates:true,accessibility:true,screenRecording:pending?'not-determined':'granted',desktop})
    const rowButton=label=>`[...document.querySelectorAll('ul[aria-label="This desktop"] button')].find(b=>b.innerText===${JSON.stringify(label)})`
    const press=async label=>{const point=await evaluate(`(()=>{const r=${rowButton(label)}.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mousePressed','mouseReleased'])await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})}
    w.setSize(760,920)
    assert.equal(await evaluate("document.querySelector('ul[aria-label=\"This desktop\"]')===null"),true,'no desktop rows where the desktop asks for nothing')
    // KDE: allow window capture, then take it away again.
    await evaluate(`(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');window.makoAsked=[];window.mako.requestComputerPermissions=async()=>{window.makoAsked.push('allow');return ${JSON.stringify(linux([{id:'kwin-window-capture',state:'granted'}],false))}};window.mako.revokeComputerPermissions=async()=>{window.makoAsked.push('remove');return ${JSON.stringify(linux([{id:'kwin-window-capture',state:'needed'}],true))}};mcpStore.set({permissions:${JSON.stringify(linux([{id:'kwin-window-capture',state:'needed'}],true))}})})()`)
    await until("document.querySelector('ul[aria-label=\"This desktop\"] li')!==null")
    assert.deepEqual(await desktopRows(),[{title:'Window capture',text:'Lets Mako capture the windows it controls, through KWin.',buttons:['Allow window capture'],status:[]}])
    assert.equal(await evaluate("document.querySelector('section[aria-label=\"Computer use\"]').innerText.includes('This desktop needs one step from you.')"),true)
    assert.equal(await evaluate("document.querySelector('section[aria-label=\"Computer use\"] button')===null"),true,'the row holds the one action')
    await capture('desktop-kde-needed.png')
    await press('Allow window capture')
    await until(`Boolean(${rowButton('Remove')})`)
    assert.deepEqual(await desktopRows(),[{title:'Window capture',text:'Mako captures the windows it controls, through KWin.',buttons:['Remove'],status:['Allowed']}])
    assert.equal(await evaluate("document.querySelector('section[aria-label=\"Computer use\"]').innerText.includes('Mako can read the screen')"),true)
    await press('Remove')
    await until(`Boolean(${rowButton('Allow window capture')})`)
    assert.deepEqual(await evaluate('window.makoAsked'),['allow','remove'])
    // Plasma 5 has nothing to grant for input: the row says what changes it, with no button.
    await evaluate(`(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');mcpStore.set({permissions:${JSON.stringify(linux([{id:'kwin-window-capture',state:'granted'},{id:'pointer-input',state:'unavailable'}],false))}})})()`)
    await until("document.querySelectorAll('ul[aria-label=\"This desktop\"] li').length===2")
    assert.deepEqual((await desktopRows())[1],{title:'Clicks and typing',text:'Upgrade to KDE Plasma 6.1 or later for these. Mako can still read windows and use app actions.',buttons:[],status:[]})
    // GNOME: install the helper, log out and back in, installed.
    await evaluate(`(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');window.mako.requestComputerPermissions=async()=>(${JSON.stringify(linux([{id:'gnome-shell-helper',state:'restart'}],true))});mcpStore.set({permissions:${JSON.stringify(linux([{id:'gnome-shell-helper',state:'needed'}],true))}})})()`)
    await until(`Boolean(${rowButton('Install helper')})`)
    assert.deepEqual(await desktopRows(),[{title:'Shell helper',text:"GNOME needs Mako's Shell helper: an extension that lets Mako list and activate windows.",buttons:['Install helper'],status:[]}])
    await capture('desktop-gnome-needed.png')
    await press('Install helper')
    await until(`Boolean(${rowButton('Uninstall')})`)
    assert.deepEqual(await desktopRows(),[{title:'Shell helper',text:'Log out and back in once to finish.',buttons:['Uninstall'],status:[]}])
    await capture('desktop-gnome-restart.png')
    await evaluate(`(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');mcpStore.set({permissions:${JSON.stringify(linux([{id:'gnome-shell-helper',state:'granted'}],false))}})})()`)
    await until("document.querySelector('ul[aria-label=\"This desktop\"]').innerText.includes('Installed')")
    assert.deepEqual(await desktopRows(),[{title:'Shell helper',text:'An extension that lets Mako list and activate windows.',buttons:['Uninstall'],status:['Installed']}])
    w.setSize(430,960)
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"),false,'the desktop rows fit a narrow window')
    await evaluate("(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');mcpStore.set({permissions:{supported:true,persistentAcrossUpdates:false,accessibility:true,screenRecording:'granted'}})})()")
    // Optional acceptance against this Mac's installed browsers; no connection is opened.
    if (process.env.MAKO_BROWSER_SETTINGS_LIVE === "1") {
    const {localBrowsers}=await import('../packages/control-runtime/dist/browser-discovery.js')
    const {InstalledBrowsers}=await import('../packages/control-runtime/dist/browser-installed.js')
    const {BrowserService}=await import('../packages/control-runtime/dist/browser-service.js')
    const {BrowserIcons}=await import('@mako/host/control/browser-icon')
    const icons=new BrowserIcons()
    const started=performance.now()
    const definitions=await localBrowsers(new InstalledBrowsers())
    const discoveryMs=performance.now()-started
    const candidates=await Promise.all(definitions.map(async browser=>({
      ...browser,
      icon:browser.applicationPath ? await icons.read(browser.applicationPath) : undefined,
    })))
    const service=new BrowserService(candidates)
    const aside=candidates.find(b=>b.applicationPath==='/Applications/Aside.app' && b.transport==='extension')
    if(aside) await service.prefer(aside.id)
    const statuses=service.status()
    assert.ok(statuses.some(b=>b.applicationPath==='/Applications/Google Chrome.app'))
    assert.ok(!statuses.some(b=>b.applicationPath==='/Applications/ChatGPT.app'))
    await evaluate(`(async()=>{const {mcpStore}=await import('/src/state/mcp.ts');mcpStore.set({browsers:${JSON.stringify(statuses)}})})()`)
    await until("document.body.innerText.includes('Google Chrome')")
    await evaluate("document.documentElement.classList.remove('light');document.documentElement.classList.add('dark')")
    w.setSize(760,920)
    await new Promise(resolve=>setTimeout(resolve,300))
    await until("[...document.images].every(i=>i.complete && i.naturalWidth>0)")
    await capture('installed-browsers.png')
    await writeFile(join(evidence,'discovery.json'),JSON.stringify({discoveryMs,browsers:statuses.map(({name,kind,applicationPath,connection,preferred})=>({name,kind,applicationPath,connection,preferred}))},null,2))
    await service.close()
    }
    console.log('PASS: production browser settings; a Linux desktop\'s asks each with its one action; pointer and keyboard selection; preference does not connect; enable/disable access; reduced-motion static frame; idle orb absent; desk excluded; setup without connection; empty state; narrow layout; light/dark captures')
  } finally {clearTimeout(timer);w.destroy();app.quit()}
}
