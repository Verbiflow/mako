import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const { createServer } = await import('vite')
  const root = await mkdtemp(join(tmpdir(), 'mako-recovery-ui-'))
  const server = await createServer({ cacheDir: join(root, 'cache'), server: {host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**']}} })
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
  const click=async(selector)=>{await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)");const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);for(const type of ['mousePressed','mouseReleased'])await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})}
  const seed=async(harness='codex',id='newest')=>evaluate(`(async()=>{const {acpStore}=await import('/src/state/acp-state.ts'); const {threadsStore}=await import('/src/state/thread-store.ts'); threadsStore.set({composerHarness:${JSON.stringify(harness)}}); const state=acpStore.get(); const live=state.conversations[state.activeKey]; acpStore.set({conversations:{...state.conversations,[state.activeKey]:{...live,harness:${JSON.stringify(harness)},session:{...live.session,harness:${JSON.stringify(harness)},status:'failed',connection:'disconnected',error:'Selected model is at capacity.'},requests:[{id:'earlier',status:'failed',failure:'network',text:'Check the earlier change.',attachments:[],error:'Connection ended.'},{id:${JSON.stringify(id)},status:'failed',failure:'rate-limited',text:'Review my changes and help resolve the merge.',attachments:[],error:'Selected model is at capacity. Please try a different model.'}],pendingPrompts:[],sending:false,permission:null}}});return true})()`)
  const evidence=resolve(process.env.MAKO_RECOVERY_EVIDENCE ?? 'docs/audits/2026-09-22/recovery-notice-ui')
  await mkdir(evidence,{recursive:true})
  const capture=async(name)=>{w.showInactive();await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.target instanceof Element && a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)");await writeFile(join(evidence,name),(await page.capturePage()).toPNG())}
  const timer=setTimeout(()=>app.exit(1),180000)
  try {
    await w.loadURL(process.env.MAKO_RECOVERY_URL+'scripts/live-workflow.html')
    await until("Boolean(document.querySelector('.composer-input'))")
    if (process.env.MAKO_NATIVE_APPROVAL_UI) {
      for (const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        await evaluate(`(async()=>{
          const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');const {applyLiveSnapshot}=await import('/src/state/live-recovery.ts');
          const s=acpStore.get(),live=s.conversations[s.activeKey],native={scope:crypto.randomUUID(),sessionId:'native-session',requestId:'native-request'};
          const receipt={id:crypto.randomUUID(),origin:{native,nativeRequestId:'callback',bindingId:s.activeKey,epoch:'fixture',generation:1,connectionGeneration:1},digest:'a'.repeat(64),createdAt:1,state:{kind:'uncertain',reason:'Lost reply'}};
          threadsStore.set({composerHarness:${JSON.stringify(harness)}});window.__nativeCalls=0;window.mako.livePermission=async()=>{window.__nativeCalls++};
          window.__nativeReceipt=receipt;
          window.__publishNative=(answerDigest)=>{const current=acpStore.get().conversations[s.activeKey];const updated={...receipt};if(answerDigest)updated.nativeDecision={identity:native,answerDigest,observedAt:2};applyLiveSnapshot({session:{...live.session,harness:${JSON.stringify(harness)},status:'ready',connection:'connected'},epoch:'native-evidence-ui',revision:(current.revision??0)+1,createdAt:1,blocks:[],base:null,requests:[],permissions:[],control:{...live.control,actions:[],transfers:[],approvalResponses:[updated]}})};window.__publishNative();
        })()`)
        await until("document.querySelector('[data-approval-recovery]')?.textContent.includes('Answer delivery unknown')")
        await evaluate("window.__publishNative('a'.repeat(64))")
        await until("!document.querySelector('[data-approval-recovery]')")
        await click('[aria-label="Conversation actions"]')
        await until("document.querySelector('[data-approval-recovery]')?.textContent.includes('Agent recorded your answer')")
        await capture(harness+'-native-confirmed-history.png')
        for(const type of ['keyDown','keyUp'])await page.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
        await evaluate("window.__publishNative('b'.repeat(64))")
        await until("document.querySelector('[data-approval-recovery]')?.textContent.includes('Agent recorded a different decision')")
        await capture(harness+'-native-different.png')
        await click('[data-approval-recovery] button[aria-label="Dismiss"]')
        await evaluate("window.__publishNative('b'.repeat(64))")
        await until("!document.querySelector('[data-approval-recovery]')")
        assert.equal(await evaluate('window.__nativeCalls'),0,'native evidence must not resend an answer')
      }
      console.log('PASS: all-six native confirmation/history, differing verdict, persistent dismissal and no answer replay')
      console.log('Visual evidence: '+evidence)
      return
    }
    if (process.env.MAKO_RECOVERY_CONTROLS) {
      w.showInactive()
      const clickText=async(scope,text)=>{
        await evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(b=>b.textContent.trim()===${JSON.stringify(text)} && b.getClientRects().length);if(!b)throw Error('Missing recovery control: '+${JSON.stringify(text)});document.querySelector('[data-test-control]')?.removeAttribute('data-test-control');b.setAttribute('data-test-control','')})()`)
        await click('[data-test-control]')
      }
      for(const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        await seed(harness,'controls-'+harness)
        await evaluate(`(async()=>{
          const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');
          const s=acpStore.get(),l=s.conversations[s.activeKey],harness=${JSON.stringify(harness)};
          threadsStore.set({descriptors:[...threadsStore.get().descriptors.filter(d=>d.provider!==harness),{provider:harness,displayName:harness,resumable:true,live:true,canResume:true,recovery:{compaction:{kind:'supported'}}}]});
          window.__recoveryMutations=[];window.mako.liveAction=async(...args)=>window.__recoveryMutations.push(args);window.mako.livePrompt=async(...args)=>window.__recoveryMutations.push(args);
          acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,session:{...l.session,status:'ready',connection:'connected'},blocks:[],requests:[
            {id:'unsent-'+harness,status:'interrupted',text:'Do not lose a pre-dispatch stop',attachments:[]},
            {id:'failed-'+harness,status:'failed',text:'Failed input remains recoverable',attachments:[],nativeDelivery:{attemptId:'fixture',bindingId:s.activeKey,ownerEpoch:'fixture',evidence:{kind:'not-accepted',source:'preflight',reason:'Not sent'}}},
            {id:'rejected-'+harness,status:'failed',failure:'transcript-rejected',text:'Review the rejected history',error:'reasoning encrypted_content was not issued to this caller',attachments:[]},
            {id:'quit-'+harness,status:'interrupted',text:'Cut short before it ran',attachments:[],interruption:{reason:'host-quit',at:1}}
          ],control:{...l.control,transfers:[],actions:[{input:{kind:'compact',id:'controls-action'},digest:'fixture',bindingId:s.activeKey,createdAt:1,state:{kind:'uncertain',reason:'Connection lost after dispatch'}}]}}}});
        })()`)
        await until("document.querySelector('[data-action-recovery] button[aria-expanded]')?.getAttribute('aria-expanded')==='false'")
        assert.equal(await evaluate("document.querySelector('[data-action-recovery]').textContent.includes('Connection lost after dispatch')"),false)
        await click('[data-action-recovery] button[aria-expanded]')
        await until("document.querySelector('[data-action-recovery]').textContent.includes('Connection lost after dispatch')")
        if(harness==='claude') await capture('action-details-expanded.png')
        await evaluate("import('/src/state/acp-state.ts').then(({acpStore})=>{const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,control:{...l.control,actions:[]}}}})})")
        assert.equal(await evaluate("document.querySelectorAll('[data-recovery-notice]').length"),1)
        assert.equal(await evaluate("document.querySelectorAll('[data-request-recovery]').length"),0)
        await clickText('[data-recovery-notice]','Review message')
        await until("document.querySelector('[data-request-recovery]')?.textContent.includes('Cut short before it ran')")
        await clickText('[data-recovery-notice]','Earlier messages (3)')
        await clickText('[data-recovery-notice]','Review the rejected history')
        await until("document.querySelector('[data-request-recovery]')?.textContent.includes('encrypted_content was not issued')")
        assert.ok(await evaluate("document.querySelector('[data-request-recovery]').textContent.includes('Use in new thread')"))
        assert.equal(await evaluate("[...document.querySelectorAll('[data-request-recovery] button')].some(b=>/Send again|Send another copy/.test(b.textContent))"),false,'rejected transcript must not offer a retry on the same binding')
        if(harness==='claude') await capture('earlier-provider-failure-expanded.png')
        await clickText('[data-recovery-notice]','Earlier messages (3)')
        await clickText('[data-recovery-notice]','Failed input remains recoverable')
        await until("document.querySelector('[data-request-recovery]')?.textContent.includes('Send again')")
        await clickText('[data-recovery-notice]','Earlier messages (3)')
        await clickText('[data-recovery-notice]','Do not lose a pre-dispatch stop')
        await until("document.querySelector('[data-request-recovery]')?.textContent.includes('Do not lose a pre-dispatch stop')")
        await evaluate(`import('/src/state/acp-state.ts').then(({acpStore})=>{const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,requests:[{id:'compact-'+${JSON.stringify(harness)},status:'failed',failure:'context-exhausted',text:'Recover after compaction',attachments:[]}],control:{...l.control,actions:[]}}}})})`)
        await clickText('[data-recovery-notice]','Review message')
        await until("[...document.querySelectorAll('[data-request-recovery] button')].some(b=>b.textContent.includes('Compact conversation') && !b.disabled)")
        await evaluate("import('/src/state/acp-state.ts').then(({acpStore})=>{const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,control:{...l.control,actions:[{input:{kind:'compact',id:'controls-action',requestId:l.requests[0].id},digest:'fixture',bindingId:s.activeKey,createdAt:1,state:{kind:'accepted'}}]}}}})})")
        await until("[...document.querySelectorAll('[data-request-recovery] button')].some(b=>b.textContent.includes('Compact conversation') && b.disabled)")
        await evaluate("import('/src/state/acp-state.ts').then(({acpStore})=>{const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,control:{...l.control,actions:l.control.actions.map(a=>({...a,state:{kind:'completed'}}))}}}})})")
        await until("document.querySelector('[data-request-recovery]')?.textContent.includes('Compaction completed. You can send')")
        if(harness==='claude') await capture('compaction-completed-expanded.png')
        await evaluate(`(async()=>{const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');const s=acpStore.get(),l=s.conversations[s.activeKey];acpStore.set({conversations:{...s.conversations,[s.activeKey]:{...l,control:{...l.control,actions:[]}}}});threadsStore.set({descriptors:threadsStore.get().descriptors.map(d=>d.provider===${JSON.stringify(harness)}?{...d,recovery:{compaction:{kind:'unavailable',reason:'Fixture cannot compact'}}}:d)});})()`)
        await until("document.querySelector('[data-request-recovery]')?.textContent.includes('Fixture cannot compact')")
        assert.ok(await evaluate("document.querySelector('[data-request-recovery]').textContent.includes('Use in new thread')"))
        assert.deepEqual(await evaluate('window.__recoveryMutations'),[],'opening recovery details must not submit work')
        await capture(harness+'-unsupported-compaction.png')
      }
      console.log('PASS: all-six recovery disclosures retain action reasons, earlier saved messages, native error text, retry eligibility and compaction state; viewing never submits work')
      console.log('Visual evidence: '+evidence)
      return
    }
    if (process.env.MAKO_APPROVAL_RECONCILIATION_FIXTURES) {
      for (const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        const fixture = JSON.parse(await readFile(join(process.env.MAKO_APPROVAL_RECONCILIATION_FIXTURES,harness+'.json'),'utf8'))
        await evaluate(`(async()=>{
          const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');const {applyLiveSnapshot}=await import('/src/state/live-recovery.ts');
          const fixture=${JSON.stringify(fixture)},key=acpStore.get().activeKey;
          threadsStore.set({composerHarness:${JSON.stringify(harness)}});
          window.__approvalCalls=[];window.mako.livePermission=async(...args)=>window.__approvalCalls.push(args);
          window.__approvalProject=snapshot=>({...snapshot,session:{...snapshot.session,id:key},permissions:snapshot.permissions.map(p=>({...p,sessionId:key})),revision:(acpStore.get().conversations[key].revision??0)+1,epoch:'reconciliation-fixture'});
          window.__approvalFixture=fixture;applyLiveSnapshot(window.__approvalProject(fixture.before));
        })()`)
        await until("document.body.textContent.includes('Old approval awaiting a native decision')")
        await capture(harness+'-before-native-end.png')
        await evaluate("import('/src/state/live-recovery.ts').then(({applyLiveSnapshot})=>applyLiveSnapshot(window.__approvalProject({...window.__approvalFixture.before,permissions:[]})))")
        await until("!document.body.textContent.includes('Old approval awaiting a native decision')")
        await capture(harness+'-ended.png')
        await evaluate("import('/src/state/live-recovery.ts').then(({applyLiveSnapshot})=>applyLiveSnapshot(window.__approvalProject(window.__approvalFixture.newer)))")
        await until("document.body.textContent.includes('New approval: allow this operation?')")
        await evaluate("import('/src/state/live-recovery.ts').then(({applyLiveSnapshot})=>applyLiveSnapshot(window.__approvalProject(window.__approvalFixture.after)))")
        assert.ok(await evaluate("document.body.textContent.includes('New approval: allow this operation?')"))
        assert.equal(await evaluate('window.__approvalCalls.length'),0,'native end must never dispatch an answer')
        await capture(harness+'-newer-preserved.png')
      }
      console.log('PASS: all-six renderer profiles remove an ended approval and preserve the newer occurrence without sending an answer')
      console.log('Visual evidence: '+evidence)
      return
    }
    if (process.env.MAKO_APPROVAL_RECOVERY) {
      for (const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        for (const outcome of ['submitted','uncertain','refused','ended']) {
          await evaluate(`(async()=>{
            const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');const {applyLiveSnapshot}=await import('/src/state/live-recovery.ts');
            const {prefsStore,setPref}=await import('/src/state/prefs.ts');setPref('dismissedRecoveryRequests',{});
            const s=acpStore.get(),live=s.conversations[s.activeKey],id=crypto.randomUUID(),outcome=${JSON.stringify(outcome)};
            const origin={nativeRequestId:'native-question',bindingId:s.activeKey,epoch:'fixture',generation:1,connectionGeneration:1,runId:id};
            const permission={id,sessionId:s.activeKey,title:'Choose the review scope',origin,options:[],questions:[{id:'scope',header:'Review scope',question:'Which changes should the agent review?',isSecret:false,allowOther:true,options:[],defaultValues:['Keep my current review scope']}]};
            threadsStore.set({composerHarness:${JSON.stringify(harness)}});
            const base={session:{...live.session,harness:${JSON.stringify(harness)},status:'running',connection:'connected'},epoch:'approval-ui',revision:(live.revision??0)+1,createdAt:1,blocks:live.blocks??[],base:null,requests:[],permissions:[permission],control:{...live.control,actions:[],transfers:[],approvalResponses:[]}};
            window.__approvalSnapshot=base;window.__approvalCalls=[];
            window.mako.liveSnapshot=async()=>window.__approvalSnapshot;
            window.mako.livePermission=async(conversation,requestId,response)=>{
              window.__approvalCalls.push({conversation,requestId,response});
              const receipt={id,digest:'fixture',origin,createdAt:1,state:{kind:'dispatching'}};
              const publish=(state,permissions)=>{const snapshot={...base,revision:window.__approvalSnapshot.revision+1,permissions,control:{...base.control,approvalResponses:[{...receipt,state}]}};window.__approvalSnapshot=snapshot;applyLiveSnapshot(snapshot)};
              publish({kind:'dispatching'},[permission]);await new Promise(resolve=>window.__finishApproval=resolve);
              if(outcome==='submitted')publish({kind:'submitted',source:'callback'},[]);
              if(outcome==='ended')publish({kind:'not-submitted',pending:false,reason:'request-ended'},[]);
              if(outcome==='refused')publish({kind:'not-submitted',pending:true,reason:'invalid-answer'},[{...permission,id:crypto.randomUUID()}]);
              if(outcome==='uncertain'){publish({kind:'uncertain',reason:'Lost fixture reply'},[permission]);throw Error('Lost fixture reply')}
            };
            applyLiveSnapshot(base);return true})()`)
          await until("[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Send answers' && n.getClientRects().length)")
          await evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Send answers' && n.getClientRects().length).setAttribute('data-test-answer','')")
          await evaluate("[...document.querySelectorAll('input')].find(n=>n.value==='Keep my current review scope').setAttribute('data-test-question','')")
          await click('[data-test-question]')
          await evaluate("document.querySelector('[data-test-question]').select();true")
          await page.debugger.sendCommand('Input.insertText',{text:'My edited review scope'})
          await click('[data-test-answer]')
          await until("document.querySelector('[data-approval-recovery]')?.textContent.includes('Sending your answer')")
          assert.equal(await evaluate("document.querySelector('[data-test-answer]').getClientRects().length"),0)
          await capture(harness+'-'+outcome+'-sending.png')
          await evaluate('window.__finishApproval();true')
          if(outcome==='submitted') {
            await until("!document.querySelector('[data-approval-recovery]')")
            await click('[aria-label="Conversation actions"]')
            await until("document.querySelector('[data-approval-recovery]')?.textContent.includes('has not confirmed receiving')")
            await capture(harness+'-submitted-history.png')
            await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
            await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
          } else {
            const title=outcome==='uncertain'?'Answer delivery unknown':outcome==='refused'?'Answer needs a correction':'Approval is no longer waiting';
            await until(`document.querySelector('[data-approval-recovery]')?.textContent.includes(${JSON.stringify(title)})`)
            const visibleAnswer=await evaluate("[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Send answers' && n.getClientRects().length)")
            assert.equal(visibleAnswer,outcome==='refused')
            if(outcome==='refused')assert.equal(await evaluate("[...document.querySelectorAll('input')].find(n=>n.value==='My edited review scope')?.value"),'My edited review scope')
            await capture(harness+'-'+outcome+'.png')
            await click('[data-approval-recovery] button[aria-label="Dismiss"]')
            await until("!document.querySelector('[data-approval-recovery]')")
            await evaluate("import('/src/state/live-recovery.ts').then(({applyLiveSnapshot})=>{applyLiveSnapshot({...window.__approvalSnapshot,revision:window.__approvalSnapshot.revision+1});return true})")
            assert.equal(await evaluate("Boolean(document.querySelector('[data-approval-recovery]'))"),false,'snapshot refresh cannot resurrect a dismissed occurrence')
            if(outcome==='uncertain') {
              await click('[aria-label="Conversation actions"]')
              await until("document.querySelector('[data-approval-recovery]')?.textContent.includes('Answer delivery unknown')")
              await capture(harness+'-unknown-history.png')
              await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
              await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
            }
          }
          assert.equal(await evaluate('window.__approvalCalls.length'),1,'presentation and recovery never resend an answer')
          if(harness==='opencode' && outcome==='uncertain') {
            const saved=await evaluate('window.__approvalSnapshot')
            await page.reload()
            await until("Boolean(document.querySelector('.composer-input'))")
            await evaluate(`import('/src/state/live-recovery.ts').then(({applyLiveSnapshot})=>{applyLiveSnapshot(${JSON.stringify(saved)});return true})`)
            assert.equal(await evaluate("Boolean(document.querySelector('[data-approval-recovery]'))"),false,'reload cannot resurrect the dismissed unknown answer')
            assert.equal(await evaluate("[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='Send answers' && n.getClientRects().length)"),false,'dismissal must never unlock answer controls')
            await capture('unknown-dismissed-after-reload.png')
          }
        }
      }
      console.log('PASS: all-six approval pending/unknown/refusal/submitted UI, preserved structured drafts, dismissal and history; one answer call')
      console.log('Visual evidence: '+evidence)
      return
    }
    if (process.env.MAKO_APPROVAL_FIXTURES) {
      for (const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        const fixture = JSON.parse(await readFile(join(process.env.MAKO_APPROVAL_FIXTURES, harness+'.json'),'utf8'))
        await evaluate(`(async()=>{
          const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');const {applyLiveSnapshot}=await import('/src/state/live-recovery.ts');
          const fixture=${JSON.stringify(fixture)},s=acpStore.get(),live=s.conversations[s.activeKey];
          threadsStore.set({composerHarness:${JSON.stringify(harness)}});
          const project=snapshot=>({...snapshot,session:{...snapshot.session,id:s.activeKey},blocks:live.blocks??[],revision:(acpStore.get().conversations[s.activeKey]?.revision??0)+1});
          window.__approvalCalls=[];
          window.mako.livePermission=async(id,requestId,response)=>{window.__approvalCalls.push({id,requestId,response});if(requestId!==fixture.first)throw Error('Wrong approval occurrence');applyLiveSnapshot(project(fixture.after))};
          applyLiveSnapshot(project(fixture.before));return true})()`)
        await until("document.body.textContent.includes('Allow operation in run-1?')")
        await capture(harness+'-approval-before.png')
        await evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='Allow').setAttribute('data-test-allow','')")
        await click('[data-test-allow]')
        await until("window.__approvalCalls.length===1 && document.body.textContent.includes('Allow operation in run-2?')")
        const calls=await evaluate('window.__approvalCalls')
        assert.equal(calls[0].requestId,fixture.first)
        assert.notEqual(calls[0].requestId,'native-request')
        assert.deepEqual(calls[0].response,{kind:'choice',optionId:'allow'})
        assert.equal(await evaluate("import('/src/state/acp-state.ts').then(({acpStore})=>acpStore.get().conversations[acpStore.get().activeKey].permission.id)"),fixture.newer)
        await capture(harness+'-newer-approval-preserved.png')
      }
      console.log('PASS: all-six approval renderer profiles use host occurrence IDs; saved host-result snapshots preserve the newer approval')
      console.log('Visual evidence: '+evidence)
      return
    }
    if (process.env.MAKO_QUEUED_STEERING) {
      const queuedId='33333333-3333-4333-8333-333333333333'
      const runningId='22222222-2222-4222-8222-222222222222'
      for(const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        for(const outcome of ['accepted','not-accepted','uncertain']) {
          await evaluate(`(async()=>{
            const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');const {applyLiveSnapshot}=await import('/src/state/live-recovery.ts');
            const s=acpStore.get(),live=s.conversations[s.activeKey];
            const harness=${JSON.stringify(harness)},outcome=${JSON.stringify(outcome)};
            document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(button=>button.click());
            threadsStore.set({composerHarness:harness,descriptors:[...threadsStore.get().descriptors.filter(d=>d.provider!==harness),{provider:harness,displayName:harness,resumable:true,live:true,canResume:true,canSteer:true}]});
            const snapshot={session:{...live.session,harness,status:'running',connection:'connected'},revision:(live.revision??0)+10,createdAt:1,base:null,blocks:live.blocks??[],permissions:[],requests:[{id:${JSON.stringify(runningId)},status:'dispatching',text:'Running review',attachments:[]},{id:${JSON.stringify(queuedId)},status:'queued',text:'Check the retry boundary exactly once.',attachments:[]}],control:{...live.control,actions:[],transfers:[]}};
            window.__queueActions=[];window.__queueEdits=[];
            window.mako.liveEditQueued=async(...args)=>{window.__queueEdits.push(args);throw Error('Renderer must not remove the queue separately')};
            window.mako.liveAction=async(id,input)=>{window.__queueActions.push(input);const action={input,digest:'fixture',bindingId:id,queueStatus:'queued',createdAt:1,state:outcome==='accepted'?{kind:outcome}:{kind:outcome,reason:outcome==='not-accepted'?'The turn changed before steering.':'Native reply was lost.'}};
              const claimed={...snapshot,revision:snapshot.revision+1,requests:snapshot.requests.map(r=>r.id===${JSON.stringify(queuedId)}?{...r,status:'canceled'}:r),control:{...snapshot.control,actions:[{...action,state:{kind:'dispatching'}}]}};applyLiveSnapshot(claimed);window.__queueSnapshot=claimed;
              await new Promise(resolve=>{window.__releaseQueuedSteer=resolve});
              const next={...snapshot,revision:snapshot.revision+2,requests:snapshot.requests.map(r=>r.id===${JSON.stringify(queuedId)}&&outcome!=='not-accepted'?{...r,status:'canceled'}:r),control:{...snapshot.control,actions:[action]}};applyLiveSnapshot(next);window.__queueSnapshot=next;return action};
            window.mako.liveSnapshot=async()=>window.__queueSnapshot;
            applyLiveSnapshot(snapshot);return true})()`)
          await until("Boolean(document.querySelector('[aria-label=\"Send now, into the running turn\"]'))")
          await capture(harness+'-'+outcome+'-before.png')
          await click('[aria-label="Send now, into the running turn"]')
          await until('window.__queueActions.length===1')
          const input=(await evaluate('window.__queueActions'))[0]
          assert.equal(input.kind,'steer-queued')
          assert.equal(input.queuedRequestId,queuedId)
          assert.equal(input.requestId,runningId)
          assert.equal(input.text,'Check the retry boundary exactly once.')
          assert.deepEqual(await evaluate('window.__queueEdits'),[])
          await until("document.querySelector('[data-action-recovery]')?.textContent.includes('awaiting confirmation')")
          assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"Send now, into the running turn\"]'))"),false)
          if(harness==='claude') await capture(outcome+'-intent-owned.png')
          await evaluate('window.__releaseQueuedSteer();true')
          if(outcome==='not-accepted') await until("Boolean(document.querySelector('[aria-label=\"Send now, into the running turn\"]'))")
          else await until("!document.querySelector('[aria-label=\"Send now, into the running turn\"]')")
          if(outcome==='uncertain') await until("document.querySelector('[data-action-recovery]')?.textContent.includes('outcome unknown')")
          await capture(harness+'-'+outcome+'-after.png')
        }
      }
      console.log('PASS: all-six queued steering button sends one atomic command; no queue-removal RPC; refusal retains queue; unknown outcome stays recoverable without queue replay')
      console.log('Visual evidence: '+evidence)
      return
    }
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
      for (const harness of ['claude','codex','cursor','grok','devin','opencode']) {
        await operationSeed(harness,'compact',{kind:'acknowledged',receipt:{at:1,outcome:{kind:'uncertain',reason:'The native reply was lost before completion could be confirmed.'}}})
        await until("!document.querySelector('[data-action-recovery]')")
        await click('[aria-label="Conversation actions"]')
        await until("document.querySelector('[data-action-recovery]')?.textContent.includes('uncertainty acknowledged')")
        assert.ok(!await evaluate("[...document.querySelectorAll('[data-action-recovery] button')].some(n=>n.textContent.includes('Disconnect and keep history'))"))
        await evaluate("[...document.querySelectorAll('[data-action-recovery] button')].find(n=>n.textContent.includes('Details')).setAttribute('data-test-details','')")
        await click('[data-test-details]')
        await until("document.querySelector('[data-action-recovery]')?.textContent.includes('The native reply was lost')")
        await capture(harness+'-acknowledged-history.png')
        await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
        await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
        await until("!document.querySelector('[data-action-recovery]')")
      }
      await operationSeed('claude','compact',{kind:'acknowledged'})
      await click('[aria-label="Conversation actions"]')
      await until("document.querySelector('[data-action-recovery]')?.textContent.includes('was not retained')")
      await capture('legacy-acknowledgement.png')
      await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
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
