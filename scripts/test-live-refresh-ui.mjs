import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const { createServer } = await import('vite')
  const root = await mkdtemp(join(tmpdir(), 'mako-live-refresh-ui-'))
  const server = await createServer({ cacheDir: join(root, 'cache'), server: {host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**']}} })
  await server.listen()
  await writeFile(join(root,'package.json'),JSON.stringify({main:fileURLToPath(import.meta.url)}))
  const env={...process.env,MAKO_REFRESH_URL:server.resolvedUrls.local[0],MAKO_REFRESH_ROOT:root}
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child=spawn(resolve('node_modules/.bin/electron'),[root],{env,stdio:'inherit'})
    process.exitCode=await new Promise((r,j)=>{child.once('exit',r);child.once('error',j)})
  } finally { await server.close(); await rm(root,{recursive:true,force:true}) }
} else {
  void check().catch(async error => { console.error(error); const {app}=await import('electron');app.exit(1) })
}

async function check() {
  const {app,BrowserWindow}=await import('electron')
  app.setPath('userData',join(process.env.MAKO_REFRESH_ROOT,'profile'))
  await app.whenReady()
  const w=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}})
  const page=w.webContents
  const evaluate=s=>page.executeJavaScript(s)
  const until=async(s)=>{const end=Date.now()+15000;while(!await evaluate(s)){if(Date.now()>end)throw Error(s);await new Promise(r=>setTimeout(r,40))}}
  const evidence=resolve('docs/audits/2026-09-23/live-refresh-notices')
  await mkdir(evidence,{recursive:true})
  const capture=async(name)=>{
    w.showInactive()
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
    await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)")
    await writeFile(join(evidence,name),(await page.capturePage()).toPNG())
  }
  const timer=setTimeout(()=>app.exit(1),90000)
  try {
    await w.loadURL(process.env.MAKO_REFRESH_URL+'scripts/live-workflow.html')
    await until("Boolean(document.querySelector('.composer-input'))")
    await evaluate(`(async()=>{
      const {acpStore}=await import('/src/state/acp-state.ts');
      const {applyLiveSnapshot,hydrateLive}=await import('/src/state/live-recovery.ts');
      const {hostConnectionStore}=await import('/src/state/host-connection.ts');
      const {RuntimeDisconnectedError,HOST_OUTAGE_MESSAGE}=await import('/electron/contracts/host-connection.ts');
      const live=acpStore.get().conversations[acpStore.get().activeKey];
      window.refreshFixture=['claude','codex','cursor','grok','devin','opencode'].map((harness,index)=>({session:{...live.session,id:'00000000-0000-4000-8000-'+String(index+100).padStart(12,'0'),harness,title:'Retained conversation'},revision:1,epoch:'fixture',createdAt:1,base:null,blocks:live.blocks,requests:[],permissions:[]}));
      window.refreshFixture.forEach(s=>applyLiveSnapshot(s));
      acpStore.set({activeKey:window.refreshFixture[0].session.id});
      window.mako.liveSnapshot=async()=>{throw new RuntimeDisconnectedError(true)};
      hostConnectionStore.set({kind:'disconnected',message:HOST_OUTAGE_MESSAGE});
      for(let round=0;round<5;round++)await Promise.all(window.refreshFixture.map(s=>hydrateLive(s.session.id)));
    })()`)
    await until("document.querySelector('[role=alert]')?.textContent.includes('Reconnecting')")
    assert.equal(await evaluate("document.querySelectorAll('[data-sonner-toast]').length"),0)
    await capture('one-connection-notice.png')
    await evaluate(`(async()=>{
      const {hydrateLive}=await import('/src/state/live-recovery.ts');
      const {hostConnectionStore}=await import('/src/state/host-connection.ts');
      window.mako.liveSnapshot=async id=>({...window.refreshFixture.find(s=>s.session.id===id),revision:10});
      await Promise.all(window.refreshFixture.map(s=>hydrateLive(s.session.id)));
      hostConnectionStore.set({kind:'connected'});
    })()`)
    await until("!document.querySelector('[role=alert]')")
    assert.equal(await evaluate("document.querySelectorAll('[data-sonner-toast]').length"),0)
    await capture('recovered-conversation.png')
    await evaluate(`(async()=>{
      const {hydrateLive,applyLiveBatch}=await import('/src/state/live-recovery.ts');
      window.refreshReads=0;window.mako.liveSnapshot=async()=>{window.refreshReads++;throw Error('The host response is too large to load in this version of Mako.')};
      const id=window.refreshFixture[0].session.id;await hydrateLive(id);
      for(let i=0;i<100;i++)applyLiveBatch({id,revision:12+i,updates:[]});
    })()`)
    await until("document.querySelector('[data-sonner-toast]')?.textContent.includes('too large to load')")
    assert.equal(await evaluate('window.refreshReads'),1)
    assert.equal(await evaluate("document.querySelectorAll('[data-sonner-toast]').length"),1)
    await capture('size-error-once.png')
    // Dismissal follows the same Sonner API as the close button; later retries
    // must not recreate an unchanged occurrence after it has been dismissed.
    await evaluate(`(async()=>{const {toast}=await import('/node_modules/.vite/deps/sonner.js');toast.dismiss('live-restore:'+window.refreshFixture[0].session.id)})()`)
    await until("!document.querySelector('[data-sonner-toast]')")
    await evaluate(`(async()=>{const {hydrateLive}=await import('/src/state/live-recovery.ts');for(let i=0;i<5;i++)await hydrateLive(window.refreshFixture[0].session.id)})()`)
    assert.equal(await evaluate("document.querySelectorAll('[data-sonner-toast]').length"),0)
    console.log('PASS: all-six outages create zero restore toasts; one shared banner, successful restoration, genuine size error once, no per-batch refetch and dismissal preserved')
    console.log('Evidence: '+evidence)
  } finally { clearTimeout(timer);w.destroy();app.quit() }
}
