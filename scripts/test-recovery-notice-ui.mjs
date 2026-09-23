import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
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
  } finally { await server.close(); await rm(join(root,"cache"),{recursive:true,force:true}) }
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
  const evidence=resolve(process.env.MAKO_RECOVERY_EVIDENCE ?? 'docs/audits/2026-09-22/recovery-notice-ui')
  await mkdir(evidence,{recursive:true})
  const capture=async(name)=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.target instanceof Element && a.effect.target.closest('[data-notice]') && a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)");await writeFile(join(evidence,name),(await page.capturePage()).toPNG())}
  const timer=setTimeout(()=>app.exit(1),90000)
  try {
    await w.loadURL(process.env.MAKO_RECOVERY_URL+'scripts/live-workflow.html')
    await until("Boolean(document.querySelector('.composer-input'))")
    if (process.env.MAKO_RECOVERY_OPERATIONS) {
      const transferId='77777777-7777-4777-8777-777777777777'
      const actionId='88888888-8888-4888-8888-888888888888'
      const operationSeed=async(harness,kind,state)=>evaluate(`(async()=>{
        const {acpStore}=await import('/src/state/acp-state.ts');
        const {threadsStore}=await import('/src/state/thread-store.ts');
        threadsStore.set({composerHarness:${JSON.stringify(harness)}});
        const s=acpStore.get(),live=s.conversations[s.activeKey],kind=${JSON.stringify(kind)},state=${JSON.stringify(state)};
        const action={input:kind==='steer'?{kind,id:${JSON.stringify(actionId)},requestId:${JSON.stringify(transferId)},text:'Check the retry boundary before changing direction.',attachments:[]}:{kind:'compact',id:${JSON.stringify(actionId)}},digest:'fixture',bindingId:s.activeKey,createdAt:1,state};
        const transfer={input:{id:${JSON.stringify(transferId)},provider:${JSON.stringify(harness)},text:'Review the saved changes.',attachments:[]},createdAt:1,state};
        acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...live,harness:${JSON.stringify(harness)},session:{...live.session,harness:${JSON.stringify(harness)},status:'ready',connection:'connected'},requests:[],pendingPrompts:[],sending:false,
          control:{...live.control,actions:kind==='transfer'?[]:[action],transfers:kind==='transfer'?[transfer]:[]}}}});return true})()`)
      for(const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        await operationSeed(harness,'transfer',{kind:'uncertain',error:'Connection closed before the switch result arrived.'})
        await until("document.querySelector('[data-transfer-recovery]')?.textContent.includes('is unconfirmed')")
        assert.ok(await evaluate("document.querySelector('[data-transfer-recovery]').textContent.includes('repeat work')"))
        assert.ok(await evaluate("document.querySelector('[data-transfer-recovery]').textContent.includes('Try switch again')"))
        await capture(harness+'-switch-unconfirmed.png')
        await operationSeed(harness,'compact',{kind:'accepted'})
        await until("document.querySelector('[data-action-recovery]')?.textContent.includes('Completion has not been confirmed')")
        assert.ok(!await evaluate("document.querySelector('[data-action-recovery]').textContent.includes('Disconnect and keep history')"))
        await operationSeed(harness,'compact',{kind:'uncertain',reason:'The agent did not confirm compaction.'})
        await until("document.querySelector('[data-action-recovery]')?.textContent.includes('does not confirm completion')")
        await capture(harness+'-compaction-unconfirmed.png')
        await operationSeed(harness,'steer',{kind:'uncertain',reason:'The reply was lost.'})
        await until("document.querySelector('[data-action-recovery]')?.textContent.includes('does not resend')")
        assert.ok(await evaluate("document.querySelector('[data-action-recovery]').textContent.includes('Acknowledge without resending')"))
      }
      // Use the production action menu to inspect a successful switch's separate prompt receipt.
      const manifest={file:'/fixture/context.md',digest:'fixture',sourceRevision:1,fromBlock:0,toBlock:1,includesBase:true,losses:[]}
      await operationSeed('codex','transfer',{kind:'accepted',bindingId:transferId,manifest})
      await evaluate(`(async()=>{const {acpStore}=await import('/src/state/acp-state.ts');const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,requests:[{id:${JSON.stringify(transferId)},status:'queued',text:'Review the saved changes.',attachments:[]}]}}});return true})()`)
      await click('[aria-label="Conversation actions"]')
      await until("document.querySelector('[data-transfer-recovery]')?.textContent.includes('waiting to be sent')")
      await capture('switch-saved-prompt-queued.png')
      await evaluate(`(async()=>{const {acpStore}=await import('/src/state/acp-state.ts');const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,requests:l.requests.map(r=>({...r,status:'dispatching',nativeDelivery:{attemptId:${JSON.stringify(transferId)},bindingId:s.activeKey,ownerEpoch:'fixture',evidence:{kind:'accepted',source:'native-response'}}}))}}});return true})()`)
      await until("document.querySelector('[data-transfer-recovery]')?.textContent.includes('destination received')")
      await capture('switch-prompt-received.png')
      await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await operationSeed('grok','transfer',{kind:'uncertain',error:'The reply was lost.'})
      await evaluate(`(async()=>{const {acpStore}=await import('/src/state/acp-state.ts');const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,control:{...l.control,transfers:l.control.transfers.map(t=>({...t,input:{...t.input,bindingId:${JSON.stringify(actionId)},modeId:'plan'}}))}}}});window.__transferRetries=[];window.mako.liveTransfer=async(id,input)=>{window.__transferRetries.push(input);const live=acpStore.get().conversations[id];return {session:live.session,revision:100,createdAt:1,base:null,blocks:live.blocks??[],requests:[],permissions:[],control:{...live.control,transfers:[...live.control.transfers,{input,createdAt:2,state:{kind:'queued'}}]}}};return true})()`)
      await evaluate("[...document.querySelectorAll('[data-transfer-recovery] button')].find(n=>n.textContent.includes('Try switch again')).setAttribute('data-test-switch','')")
      await capture('switch-before-retry.png')
      await click('[data-test-switch]')
      await until('window.__transferRetries.length===1')
      const retryInput=(await evaluate('window.__transferRetries'))[0]
      assert.notEqual(retryInput.id,transferId)
      assert.equal(retryInput.bindingId,actionId)
      assert.equal(retryInput.modeId,'plan')
      await until("document.querySelector('[data-transfer-recovery]')?.textContent.includes('after this turn')")
      await capture('explicit-switch-retry.png')
      await operationSeed('claude','compact',{kind:'uncertain',reason:'The reply was lost.'})
      await evaluate(`window.__actionAcknowledgements=[];window.mako.liveAcknowledgeAction=async(...args)=>{window.__actionAcknowledgements.push(args)};window.mako.liveSnapshot=async()=>null;true`)
      await evaluate("[...document.querySelectorAll('[data-action-recovery] button')].find(n=>n.textContent.includes('Disconnect and keep history')).setAttribute('data-test-ack','')")
      await capture('compaction-before-ack.png')
      await click('[data-test-ack]')
      await until('window.__actionAcknowledgements.length===1')
      assert.equal((await evaluate('window.__actionAcknowledgements'))[0][1],actionId)
      await evaluate("document.querySelector('aside[aria-label=\"Agents companion\"]').style.display='none'")
      w.setSize(430,800)
      await capture('narrow-action-recovery.png')
      console.log('PASS: all-six operation guidance, acceptance distinct from completion, correlated transfer prompt receipt updates in menu, explicit action acknowledgement')
      console.log('Visual evidence: '+evidence)
      return
    }
    if (process.env.MAKO_RECOVERY_SNAPSHOT) {
      const snapshot=JSON.parse(await readFile(process.env.MAKO_RECOVERY_SNAPSHOT,'utf8'))
      const request=snapshot.requests.findLast(request=>request.status==='failed')
      assert.equal(request.failure,'auth')
      assert.equal(request.nativeDelivery.evidence.kind,'accepted')
      assert.ok(request.error.includes('OAuth session expired'))
      const apply=`(async()=>{const {applyLiveSnapshot}=await import('/src/state/live-recovery.ts');const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');threadsStore.set({composerHarness:${JSON.stringify(snapshot.session.harness)}});applyLiveSnapshot(${JSON.stringify(snapshot)});acpStore.set({activeKey:${JSON.stringify(snapshot.session.id)}});return true})()`
      await evaluate(apply)
      await until("Boolean(document.querySelector('[data-recovery-notice]'))")
      await until("document.querySelector('[data-recovery-notice]').textContent.includes('Sign-in required')")
      await capture('native-auth-compact.png')
      await click('[data-recovery-notice] button[aria-expanded]')
      await until("document.querySelector('[data-recovery-notice]').textContent.includes('OAuth session expired')")
      assert.ok(!await evaluate("document.querySelector('[data-recovery-notice]').textContent.includes('session itself is intact')"))
      await capture('native-auth-expanded.png')
      await click('[aria-label="Dismiss error"]')
      await evaluate(apply)
      assert.equal(await evaluate("Boolean(document.querySelector('[data-recovery-notice]'))"),false)
      await capture('native-auth-dismissed.png')
      console.log('PASS: real native failure snapshot displays auth guidance, retained error details and persistent occurrence dismissal in the production renderer fixture')
      console.log('Visual evidence: '+evidence)
      return
    }
    if (process.env.MAKO_RECOVERY_DELIVERY) {
      const update = async (kind, connected = false, status = 'failed', sessionStatus = 'failed') => evaluate(`(async()=>{
        const {acpStore}=await import('/src/state/acp-state.ts');
        const s=acpStore.get(),live=s.conversations[s.activeKey];
        const evidence=${JSON.stringify(kind)};
        acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...live,
          session:{...live.session,status:${JSON.stringify(sessionStatus)},connection:${JSON.stringify(connected ? 'connected' : 'disconnected')}},
          requests:live.requests.map((request,index)=> index===live.requests.length-1 ? {...request,status:${JSON.stringify(status)},failure:'network',error:'Connection ended.',
            nativeDelivery:evidence ? {attemptId:'11111111-1111-4111-8111-111111111111',bindingId:'fixture',ownerEpoch:'fixture',evidence:evidence==='accepted'?{kind:evidence,source:'native-response'}:evidence==='not-accepted'?{kind:evidence,source:'preflight',reason:'Not connected'}:{kind:evidence,reason:'Lost response'}} : undefined} : request)
        }}});return true})()`)
      const button = "[...document.querySelectorAll('[data-request-recovery] button')].find(n=>/Send again|Send another copy/.test(n.textContent))"
      for (const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        await seed(harness,'delivery-'+harness)
        await update(undefined)
        if(harness==='codex') await capture('compact.png')
        await click('[data-recovery-notice] button[aria-expanded]')
        await until("Boolean(document.querySelector('[data-delivery-evidence=unknown]'))")
        assert.equal(await evaluate(`${button}.textContent`),'Send another copy')
        assert.equal(await evaluate(`${button}.disabled`),true,'Disconnected session cannot resend')
        if(harness==='codex') await capture('legacy-unconfirmed.png')
        // The details stay open while a late native receipt changes the request.
        await update('accepted')
        await until("Boolean(document.querySelector('[data-delivery-evidence=accepted]'))")
        assert.ok(await evaluate("document.querySelector('[data-delivery-evidence]').textContent.includes('agent received')"))
        assert.equal(await evaluate(`${button}.textContent`),'Send another copy')
        await capture(harness+'-accepted.png')
        await update('accepted',true,'failed','running')
        assert.equal(await evaluate(`${button}.disabled`),true,'Active session cannot resend')
        await update('not-accepted')
        await until("Boolean(document.querySelector('[data-delivery-evidence=not-accepted]'))")
        assert.equal(await evaluate(`${button}.textContent`),'Send again')
        if(harness==='codex') await capture('preflight-not-sent.png')
        await update('uncertain',false,'uncertain')
        await until("document.querySelector('[data-recovery-notice]').textContent.includes('Message delivery is unconfirmed')")
        assert.equal(await evaluate(`Boolean(${button})`),false)
        await update('accepted',false,'uncertain')
        await until("document.querySelector('[data-recovery-notice]').textContent.includes('Message outcome is unconfirmed')")
        await click('[aria-label="Dismiss error"]')
      }
      await seed('codex','explicit-copy')
      await update('accepted',true)
      await click('[data-recovery-notice] button[aria-expanded]')
      await until(`${button}?.disabled===false`)
      await evaluate("window.__recoverySends=[];window.mako.livePrompt=async(...args)=>{window.__recoverySends.push(args)};true")
      await capture('explicit-copy-ready.png')
      await evaluate(`${button}.setAttribute('data-test-resend','')`)
      await click('[data-test-resend]')
      await until("window.__recoverySends.length===1")
      const calls=await evaluate('window.__recoverySends')
      assert.notEqual(calls[0][1],'explicit-copy','Deliberate resend uses a new operation ID')
      assert.equal(calls[0][2],'Review my changes and help resolve the merge.')
      assert.equal(await evaluate("(async()=>{const {acpStore}=await import('/src/state/acp-state.ts');const s=acpStore.get();return s.conversations[s.activeKey].requests.find(r=>r.id==='explicit-copy').nativeDelivery.evidence.kind})()"),'accepted')
      await until("document.querySelector('[data-test-resend]').disabled")
      await capture('explicit-copy-sent.png')
      await evaluate("document.querySelector('aside[aria-label=\"Agents companion\"]').style.display='none'")
      w.setSize(430,800)
      await capture('narrow.png')
      console.log('PASS: all-six receipt/refusal/legacy/uncertain presentation, late receipt while expanded, disconnected guard, explicit new-operation send and original receipt retained')
      console.log('Visual evidence: '+evidence)
      return
    }
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
    await until("[...document.querySelectorAll('button[aria-expanded]')].some(n=>n.textContent.includes('Saved messages (2)'))")
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
