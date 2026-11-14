import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

// Production rail, search and viewing actions with an isolated bridge/profile.
// Native internal-review metadata, never titles or a worker's selected role,
// decides which sessions are ordinary conversations. No provider is launched.
if (process.versions.electron) {
  void check().catch(async error => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const { default: electron } = await import("electron")
  const root = testScratch("mako-internal-review-ui-", { given: process.argv[2] })
  await mkdir(root, { recursive: true })
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: Number(process.env.MAKO_THREAD_PORT ?? 0), strictPort: true, watch: null, fs: { strict: false } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-internal-review-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_INTERNAL_UI_ROOT: root, MAKO_INTERNAL_UI_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electron, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(electronExit("The internal review UI check", code, signal)))
    })
  } finally { await server.close() }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_INTERNAL_UI_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The internal review UI check", ms: 120_000 })
  const errors = []
  page.on("console-message", details => { if (details.level === "error") errors.push(details.message) })
  const evaluate = code => page.executeJavaScript(code)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const until = async (code, label = code) => {
    guard.at(label)
    const end = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out: ${label}; ${errors.join("; ")}`)
      await pause(25)
    }
  }
  try {
    await window.loadURL(`${process.env.MAKO_INTERNAL_UI_URL}?mock`)
    await until("Boolean(document.querySelector('[data-composer] textarea'))", "the fixture desk")
    await evaluate(`(async () => {
      const t = await import('/src/state/threads.ts');
      const v = await import('/src/state/thread-viewing.ts');
      const tabs = await import('/src/state/thread-tabs.ts');
      const base = {harness:'codex', cwd:'/fixture/project', updatedAt:new Date().toISOString()};
      const internal = {...base, path:'/fixture/internal.jsonl', nativeId:'internal', title:'Guardian review', nativeAgent:{kind:'internal-review', source:'guardian_review', role:'guardian'}};
      const worker = {...base, path:'/fixture/worker.jsonl', nativeId:'worker', title:'Guardian worker conversation', nativeAgent:{kind:'agent', role:'guardian'}};
      const unknown = {...base, path:'/fixture/unknown.jsonl', nativeId:'unknown', title:'Unknown source conversation', nativeAgent:{kind:'unknown', role:'future'}};
      const stale = {...internal}; delete stale.nativeAgent;
      const refs = [internal, worker, unknown];
      const page = ref => ({ref,entries:ref===internal?[]:[{type:'user',id:'u',text:'Ordinary worker prompt'},{type:'text',id:'a',text:'Ordinary worker answer'}],start:0,total:ref===internal?0:2,hasEarlier:false});
      window.mako.resolveOwner = async () => null;
      window.mako.pageThread = async path => page(refs.find(ref=>ref.path===path));
      window.mako.previewThread = async () => null;
      window.mako.threadRun = async () => null;
      window.mako.followThread = async () => {};
      window.mako.unfollowThread = async () => {};
      window.reviewFixture = {t,v,tabs,internal,worker,unknown,stale};
      t.applyThreads(refs);
      return true;
    })()`)
    await frame()
    const only = process.env.MAKO_INTERNAL_UI_CASE
    if (!only || only === "pagination") {
      // Keep the mounted desk's automatic scroll paging out of these exact
      // response sequences; exercise the same production state in a renderer.
      await writeFile(join(root,'pagination.html'),'<!doctype html><title>Native page identity fixture</title>')
      const reader = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}})
      await reader.loadURL(new URL('/@fs'+join(root,'pagination.html'),process.env.MAKO_INTERNAL_UI_URL).href)
      let result
      try {
        result = await reader.webContents.executeJavaScript(`(async () => {
        const {installMockBridge}=await import('/src/dev/mock-bridge.ts');installMockBridge();
        const t=await import('/src/state/threads.ts'),v=await import('/src/state/thread-viewing.ts'),tabs=await import('/src/state/thread-tabs.ts');
        const f={t,v,tabs,unknown:{harness:'codex',cwd:'/fixture/project',updatedAt:new Date().toISOString(),title:'Unknown source conversation'}};
        const d=await import('/src/state/drafts.ts'),owners=await import('/src/state/thread-store.ts');
        const before=window.mako.pageThread,results=[],races=[];
        const setup=(kind,suffix,sessionId)=>{
          const ref={...f.unknown,path:'/fixture/'+kind+'-'+suffix,nativeId:kind+'-'+suffix,identity:'store',bytes:40,revision:1,...(sessionId?{sessionId}:{})};
          f.t.applyThreadRef(ref);
          const entries=kind==='released'?Array.from({length:5},(_,i)=>({type:'text',id:'cached-'+i,text:'cached'})):[{type:'text',id:'tail',text:'tail'}];
          const shown={...f.v.viewedThread({ref,entries}),pageStart:kind==='released'?0:4,totalEntries:5,hasEarlier:kind!=='released',
            ...(kind==='released'?{releasedTurns:[{id:'released',label:'released',blocks:{start:0,end:0},base:{start:0,end:4}}]}:{})};
          f.v.rememberThread(shown);f.t.threadsStore.set({viewing:shown,opening:null});f.tabs.openThreadTab(ref.path);d.rememberDraft(ref.path,'Paging draft');
          return {ref,shown};
        };
        const read=kind=>kind==='released'?f.v.loadReleasedThreadTurn(f.t.threadsStore.get().viewing.ref.path,'released'):f.v.threadViewingActions.loadEarlier();
        for(const kind of ['released','earlier']) for(const conflict of [false,true]) {
          const {ref,shown}=setup(kind,'conflict-'+conflict);let calls=0;const publications=[];
          const observe=()=>{const view=f.t.threadsStore.get().viewing;publications.push(view.entries.some(e=>e.id?.startsWith('page-'))?view.entries.filter(e=>e.id?.startsWith('page-')).map(e=>e.text):[])};
          const off=f.t.threadsStore.subscribe(observe);
          window.mako.pageThread=async(path,before)=>{calls++;const sessionId=conflict&&before===2?'session-B':'session-A';return {ref:{...ref,sessionId},entries:[{type:'text',id:'page-'+before+'a',text:sessionId},{type:'text',id:'page-'+before+'b',text:sessionId}],start:before-2,total:5,hasEarlier:before>2}};
          await read(kind);off();const view=f.t.threadsStore.get().viewing,cache=f.v.rememberedThread(ref.path);
          results.push({kind,conflict,calls,pageStart:view.pageStart,cachePageStart:cache.pageStart,sessionId:view.ref.sessionId??null,ownerSessionId:owners.nativeSessionRefs.version(ref.path)?.ref.sessionId??null,
            shared:view===cache,restored:cache.releasedTurns?.length===0,unchanged:JSON.stringify(view.entries)===JSON.stringify(shown.entries),loading:Boolean(view.loadingEarlier),
            publications:publications.filter(p=>p.length),sessions:[...new Set(view.entries.filter(e=>e.id?.startsWith('page-')).map(e=>e.text))],draft:d.draftText(ref.path)});
        }
        for(const kind of ['released','earlier']) for(const change of ['worker','aba','refresh','missing',...(kind==='earlier'?['error']:[])]) {
          const {ref,shown}=setup(kind,'race-'+change,'session-A');let release,entered,calls=0;
          const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
          window.mako.pageThread=async(path,before)=>{calls++;if(calls===2){entered();await gate;if(change==='missing')return null;if(change==='error')throw new Error('Overtaken page read')}return {ref:{...ref,sessionId:'session-A'},entries:[{type:'text',id:'page-'+before+'a',text:'old'},{type:'text',id:'page-'+before+'b',text:'old'}],start:before-2,total:5,hasEarlier:before>2}};
          const pending=read(kind);await started;
          const worker={...ref,sessionId:'session-B'};if(change!=='refresh')f.t.applyThreadRef(worker);
          const current=change==='aba'||change==='refresh'?ref:worker;f.t.applyThreadRef(current);
          const replacement={...(change==='refresh'?f.v.rememberedThread(ref.path):shown),ref:current,entries:[...shown.entries.slice(0,-1),{type:'text',id:'replacement',text:'new incarnation'}]};
          f.v.rememberThread(replacement);f.t.threadsStore.set({viewing:replacement});d.rememberDraft(ref.path,'New worker draft');
          const version=owners.nativeSessionRefs.version(ref.path);release();await pending;
          const view=f.t.threadsStore.get().viewing,cache=f.v.rememberedThread(ref.path);
          races.push({kind,change,view:change==='refresh'?view===cache&&view.entries.at(-1)?.id==='replacement'&&view.entries.filter(e=>e.id?.startsWith('page-')).length===4:view===replacement,cache:change==='refresh'?cache!==replacement:cache===replacement,
            owner:owners.nativeSessionRefs.version(ref.path)===version,tab:f.tabs.threadTabsStore.get().tabs.includes(ref.path),draft:d.draftText(ref.path)});
        }
        const mixed=[];
        for(const mode of ['cancel','overlap','same-overlap','failure','retire','offscreen']) {
          const {ref}=setup('earlier','mixed-'+mode,mode==='same-overlap'?'session-A':undefined);
          const placed={...ref,sessionId:'session-A'};
          const entries=Array.from({length:5},(_,i)=>({type:'text',id:'held-'+i,text:'held'}));
          const shown={...f.v.viewedThread({ref,entries}),pageStart:4,totalEntries:9,hasEarlier:true,
            releasedTurns:[{id:'released',label:'released',blocks:{start:0,end:0},base:{start:4,end:6}}]};
          f.v.rememberThread(shown);f.t.threadsStore.set({viewing:shown});
          let releaseOld,releaseNew,oldEntered,newEntered,calls=0,phase='old';
          const oldGate=new Promise(r=>releaseOld=r),newGate=new Promise(r=>releaseNew=r);
          const oldStarted=new Promise(r=>oldEntered=r),newStarted=new Promise(r=>newEntered=r);
          window.mako.pageThread=async(path,before)=>{
            calls++;
            if(before===undefined)return {ref:placed,entries,start:4,total:9,hasEarlier:true};
            if(before===4&&phase==='old'){oldEntered();await oldGate;if(mode==='failure')throw new Error('Earlier page failed')}
            else if(before===4&&phase==='new'){newEntered();await newGate}
            return {ref:placed,entries:[{type:'text',id:'page-'+before+'a',text:'session-A'},{type:'text',id:'page-'+before+'b',text:'session-A'}],start:before-2,total:9,hasEarlier:before>2};
          };
          const old=f.v.threadViewingActions.loadEarlier();await oldStarted;
          const oldToken=f.t.threadsStore.get().viewing.loadingEarlier;
          if(mode==='retire')f.t.applyThreadRef({...placed,nativeAgent:{kind:'internal-review',source:'guardian_review',role:'guardian'}});
          else if(mode!=='failure'&&mode!=='same-overlap')await f.v.loadReleasedThreadTurn(ref.path,'released');
          if(mode==='offscreen')f.v.threadViewingActions.closeViewer();
          let newer,newToken;
          if((mode==='overlap'||mode==='same-overlap')){
            await f.v.readThreadForPane(ref.path);phase='new';
            newer=f.v.threadViewingActions.loadEarlier();await newStarted;
            newToken=f.t.threadsStore.get().viewing.loadingEarlier;
          }
          releaseOld();await old;
          const settled=f.v.rememberedThread(ref.path),current=f.t.threadsStore.get().viewing;
          const item={mode,loading:Boolean(settled?.loadingEarlier),shared:!current||current===settled,sessionId:settled?.ref.sessionId??null,
            retired:!settled,distinctToken:!['overlap','same-overlap'].includes(mode)||oldToken!==newToken};
          if((mode==='overlap'||mode==='same-overlap')){
            item.newerStillBusy=Boolean(current.loadingEarlier)&&current.loadingEarlier===newToken;
            releaseNew();await newer;
          } else if(mode==='cancel'||mode==='failure') {
            phase='ready';const previous=calls;await f.v.threadViewingActions.loadEarlier();item.retryCalled=calls>previous;
          }
          const final=f.v.rememberedThread(ref.path);
          item.finalLoading=Boolean(final?.loadingEarlier);item.pageStart=final?.pageStart??null;
          item.draft=d.draftText(ref.path);mixed.push(item);
        }
        window.mako.pageThread=before;return {results,races,mixed};
      })()`)
      } finally { reader.destroy() }
      await writeFile(join(root,'pagination-results.json'),JSON.stringify(result,null,2))
      for (const item of result.results) {
        assert.equal(item.calls,2,JSON.stringify(item))
        assert.equal(item.shared,true,'view and cache publish the same accepted history: '+JSON.stringify(item))
        assert.equal(item.loading,false,'refused reads release their loading state: '+JSON.stringify(item))
        assert.equal(item.draft,'Paging draft')
        if (item.conflict) {
          assert.equal(item.unchanged,true,'conflicting placed identities cannot publish any fetched history: '+JSON.stringify(item))
          assert.deepEqual(item.publications,[],'no partial publication before refusal')
          assert.equal(item.sessionId,null)
          assert.equal(item.ownerSessionId,null)
          if (item.kind==='released') assert.equal(item.restored,false)
          else assert.equal(item.pageStart,4)
        } else {
          assert.deepEqual(item.sessions,['session-A'])
          assert.equal(item.sessionId,'session-A','complete placement retained in view')
          assert.equal(item.ownerSessionId,'session-A','unchanged owner accepts complete placement')
          assert.equal(item.pageStart,0)
          assert.equal(item.cachePageStart,0)
          if (item.kind==='released') assert.equal(item.restored,true)
        }
      }
      for (const item of result.races) assert.deepEqual(item,{kind:item.kind,change:item.change,view:true,cache:true,owner:true,tab:true,draft:'New worker draft'},'superseded read cannot publish through path/identity reuse')
      for (const item of result.mixed) {
        assert.equal(item.shared,true,JSON.stringify(item))
        assert.equal(item.draft,'Paging draft')
        assert.equal(item.finalLoading,false,'only its operation can retain the busy state: '+JSON.stringify(item))
        if(item.mode==='overlap'||item.mode==='same-overlap') {
          assert.equal(item.distinctToken,true,'successor read owns a distinct busy token')
          assert.equal(item.newerStillBusy,true,'older finally must not clear successor loading')
        } else assert.equal(item.loading,false,'settled read leaves no inherited busy flag: '+JSON.stringify(item))
        if(item.mode==='retire')assert.equal(item.retired,true)
        if(item.mode==='cancel'||item.mode==='failure')assert.equal(item.retryCalled,true,'next ordinary load is admitted')
        if(['cancel','overlap','same-overlap','failure'].includes(item.mode))assert.equal(item.pageStart,0,'next ordinary read completes')
      }
      console.log('PASS accumulated page identity and coherent owner/view/cache publication; conflicting pages, ABA and new-worker refusal')
    }
    if (!only || only === "arrival") {
      const arrival = await evaluate("import('/scripts/fixtures/session-tab-arrivals.tsx').then(f=>f.sessionTabArrivals())")
      await writeFile(join(root,'arrival-results.json'),JSON.stringify(arrival,null,2))
      assert.deepEqual(arrival,{initialNew:0,firstNew:false,laterNew:true},'initial identity cohort stays still during slow render; genuinely added tab animates')
      console.log('PASS slow initial strip and genuine later tab arrival')
    }
    if (!only || only === "boundaries") {
      const result = await evaluate(`(async () => {
        const f=reviewFixture,d=await import('/src/state/drafts.ts'),before=window.mako.pageThread;
        const internal={...f.internal,nativeId:'omitted-session',path:'/fixture/omitted-session.jsonl',sessionId:'internal-session'};
        const worker={...f.worker,nativeId:internal.nativeId,path:internal.path,sessionId:'worker-session'};
        f.t.applyThreadRef(internal);f.t.applyThreadRef(worker);
        const view=f.v.viewedThread({ref:worker,entries:[{type:'text',id:'w',text:'Worker B'}]});
        f.v.rememberThread(view);f.tabs.openThreadTab(worker.path);f.t.threadsStore.set({viewing:view,opening:null});d.rememberDraft(worker.path,'Placed worker draft');
        const omitted={...internal};delete omitted.sessionId;f.t.applyThreadRef(omitted);
        const wildcard={view:f.t.threadsStore.get().viewing===view,cache:f.v.rememberedThread(worker.path)===view,tab:f.tabs.threadTabsStore.get().tabs.includes(worker.path),row:f.t.threadsStore.get().threads.some(ref=>ref.sessionId===worker.sessionId),draft:d.draftText(worker.path)==='Placed worker draft'};
        let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
        window.mako.pageThread=async()=>{entered();await gate;return {ref:omitted,entries:[],start:0,total:0,hasEarlier:false}};
        const oldReply=f.v.readThreadForPane(worker.path);await started;f.t.applyThreadRef(omitted);release();
        const delayed={returned:(await oldReply)!==null,view:f.t.threadsStore.get().viewing===view,cache:f.v.rememberedThread(worker.path)===view,tab:f.tabs.threadTabsStore.get().tabs.includes(worker.path),draft:d.draftText(worker.path)==='Placed worker draft'};
        const originless={...internal};delete originless.sessionId;delete originless.nativeAgent;f.t.applyThreads([originless,worker]);
        delayed.row=f.t.threadsStore.get().threads.some(ref=>ref.sessionId===worker.sessionId);
        const pages=[];
        for(const learns of [false,true]) {
          const ref={...f.unknown,nativeId:'intermediate-'+learns,path:'/fixture/intermediate-'+learns+'.jsonl',bytes:40,revision:1};
          f.t.applyThreadRef(ref);f.v.rememberThread({...f.v.viewedThread({ref,entries:[]}),pageStart:0,totalEntries:3});
          let calls=0;
          window.mako.pageThread=async(path,before)=>{calls++;return before===undefined?{ref,entries:[{type:'text',id:'tail',text:'tail'}],start:2,total:3,hasEarlier:true}:{ref:{...ref,nativeAgent:{kind:learns?'internal-review':'agent'}},entries:[{type:'user',id:'early',text:'early'},{type:'text',id:'answer',text:'answer'}],start:0,total:3,hasEarlier:false}};
          const read=await f.v.readThreadForPane(ref.path);
          pages.push({learns,calls,returned:read!==null,cache:Boolean(f.v.rememberedThread(ref.path)),entries:read?.entries.length??0});
        }
        const placed={...f.unknown,nativeId:'mixed-placement',path:'/fixture/mixed-placement.jsonl',sessionId:'ordinary-session',bytes:40,revision:1};
        const partial={...placed};delete partial.sessionId;
        f.t.applyThreadRef(placed);f.v.rememberThread({...f.v.viewedThread({ref:placed,entries:[]}),pageStart:0,totalEntries:3});
        window.mako.pageThread=async(path,before)=>before===undefined?{ref:partial,entries:[{type:'text',id:'tail',text:'tail'}],start:2,total:3,hasEarlier:true}:{ref:placed,entries:[{type:'user',id:'u',text:'early'},{type:'text',id:'a',text:'answer'}],start:0,total:3,hasEarlier:false};
        const mixed=await f.v.readThreadForPane(placed.path);
        const earlyWorker={...f.worker,nativeId:'before-classification',path:'/fixture/before-classification',sessionId:'current-worker'};
        const partialWorker={...earlyWorker};delete partialWorker.sessionId;delete partialWorker.nativeAgent;
        f.t.applyThreadRef(earlyWorker);f.t.applyThreadRef(partialWorker);
        window.mako.pageThread=async()=>({ref:partialWorker,entries:[],start:0,total:0,hasEarlier:false});
        const earlyRead=await f.v.readThreadForPane(earlyWorker.path);
        const lateInternal={...f.internal,nativeId:earlyWorker.nativeId,path:earlyWorker.path,sessionId:'older-internal'};
        f.t.applyThreadRef(lateInternal);const partialInternal={...lateInternal};delete partialInternal.sessionId;f.t.applyThreadRef(partialInternal);
        const placement={read:earlyRead?.ref.sessionId===earlyWorker.sessionId,row:f.t.threadsStore.get().threads.some(ref=>ref.nativeId===earlyWorker.nativeId&&ref.sessionId===earlyWorker.sessionId),cache:f.v.rememberedThread(earlyWorker.path)?.ref.sessionId===earlyWorker.sessionId};
        const released=[];
        for(const learns of [false,true]) {
          const ref={...f.unknown,nativeId:'released-'+learns,path:'/fixture/released-'+learns,bytes:40,revision:1};f.t.applyThreadRef(ref);
          f.v.rememberThread({...f.v.viewedThread({ref,entries:[{type:'user',id:'u',text:'released'},{type:'text',id:'a',text:''},{type:'text',id:'tail',text:'tail'}]}),releasedTurns:[{id:'released',label:'released',blocks:{start:0,end:0},base:{start:0,end:2}}]});
          window.mako.pageThread=async()=>({ref:{...ref,...learns&&{nativeAgent:{kind:'internal-review'}}},entries:[{type:'user',id:'u',text:'restored'},{type:'text',id:'a',text:'answer'}],start:0,total:3,hasEarlier:false});
          await f.v.loadReleasedThreadTurn(ref.path,'released');const restored=f.v.rememberedThread(ref.path);
          released.push({learns,cache:Boolean(restored),restored:restored?.releasedTurns?.length===0});
        }
        window.mako.pageThread=before;return {wildcard,delayed,pages,mixed:{returned:Boolean(mixed),session:mixed?.ref.sessionId,entries:mixed?.entries.length},placement,released};
      })()`)
      await writeFile(join(root,'boundary-results.json'),JSON.stringify(result,null,2))
      assert.deepEqual(result.wildcard,{view:true,cache:true,tab:true,row:true,draft:true},'omitted placement cannot bridge internal A into distinct known worker B')
      assert.deepEqual(result.delayed,{returned:false,view:true,cache:true,tab:true,draft:true,row:true},'omitted old page and originless snapshot preserve placed worker B')
      assert.deepEqual(result.pages,[{learns:false,calls:2,returned:true,cache:true,entries:3},{learns:true,calls:2,returned:false,cache:false,entries:0}],'every consumed page admits classification before aggregation')
      assert.deepEqual(result.mixed,{returned:true,session:'ordinary-session',entries:3},'one unchanged ordinary capture can supply missing placement from its complete page')
      assert.deepEqual(result.placement,{read:true,row:true,cache:true},'ordinary partial updates and single-page reads cannot erase a known worker placement before internal metadata arrives')
      assert.deepEqual(result.released,[{learns:false,cache:true,restored:true},{learns:true,cache:false,restored:false}],'released-turn page admission preserves ordinary history and rejects internal classification')
      console.log('PASS omitted placed identity and intermediate-page classification with ordinary pagination control')
    }
    if (!only || only === "race") {
      const result = await evaluate(`(async () => {
        const f=reviewFixture, internal={...f.internal,nativeId:'uncached-review',path:'/fixture/uncached.jsonl'};
        const stale={...internal}; delete stale.nativeAgent;
        f.t.applyThreads([stale,f.worker,f.unknown]);
        let release,entered; const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
        const before=window.mako.pageThread;
        window.mako.pageThread=async path=>{entered();await gate;return {ref:stale,entries:[],start:0,total:0,hasEarlier:false}};
        const reading=f.v.readThreadForPane(stale.path); await started;
        f.t.applyThreadRef(internal); release(); const returned=await reading;
        const cached=Boolean(f.v.rememberedThread(stale.path));
        f.t.applyThreads([stale,f.worker,f.unknown]);
        const listed=f.t.threadsStore.get().threads.some(ref=>ref.nativeId===internal.nativeId);
        f.t.applyThreadRef(stale);
        const listedByEvent=f.t.threadsStore.get().threads.some(ref=>ref.nativeId===internal.nativeId);
        window.mako.pageThread=before;
        return {returned:returned!==null,cached,listed,listedByEvent};
      })()`)
      await writeFile(join(root,"race-results.json"),JSON.stringify(result,null,2))
      assert.deepEqual(result,{returned:false,cached:false,listed:false,listedByEvent:false}, "late originless pane/list/event cannot resurrect a classified native identity")
      console.log("PASS uncached read and stale list/event classification fences")
    }
    if (!only || only === "identity") {
      const result = await evaluate(`(async () => {
        const f=reviewFixture,d=await import('/src/state/drafts.ts');
        const internal={...f.internal,path:'/fixture/reused.jsonl',nativeId:'reused-review'};
        const worker={...f.worker,path:internal.path,nativeId:'reused-worker',sessionId:'worker-session'};
        f.t.applyThreads([worker,f.unknown]);
        const view=f.v.viewedThread({ref:worker,entries:[{type:'text',id:'worker',text:'Real worker still here'}]});
        f.v.rememberThread(view);f.tabs.openThreadTab(worker.path);f.t.threadsStore.set({viewing:view,opening:null});
        d.rememberDraft(worker.path,'Keep the worker draft');
        f.t.applyThreadRef({...internal,sessionId:'review-session'});
        const after={view:f.t.threadsStore.get().viewing?.ref.nativeId===worker.nativeId,cache:f.v.rememberedThread(worker.path)?.ref.nativeId===worker.nativeId,tab:f.tabs.threadTabsStore.get().tabs.includes(worker.path),row:f.t.threadsStore.get().threads.some(ref=>ref.nativeId===worker.nativeId),draft:d.draftText(worker.path)==='Keep the worker draft'};
        f.t.applyThreads([internal,f.unknown]);
        after.snapshot=f.t.threadsStore.get().threads.some(ref=>ref.nativeId===worker.nativeId);
        return after;
      })()`)
      await writeFile(join(root,"identity-results.json"),JSON.stringify(result,null,2))
      assert.deepEqual(result,{view:true,cache:true,tab:true,row:true,draft:true,snapshot:true}, "retirement belongs to the native/session identity, not a reused path")
      console.log("PASS genuine worker view/cache/tab/draft/row at reused path preserved")
    }
    if (!only || only === "successor") {
      const result = await evaluate(`(async () => {
        const f=reviewFixture,internal={...f.internal,nativeId:'reading-review',path:'/fixture/reading-reuse.jsonl'};
        const stale={...internal}; delete stale.nativeAgent;
        const worker={...f.unknown,nativeId:'new-native-worker',path:internal.path}; delete worker.nativeAgent;
        f.t.applyThreadRef(stale);
        let release,entered; const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
        let calls=0; const before=window.mako.pageThread;
        window.mako.pageThread=async () => {calls++;if(calls===1){entered();await gate;return {ref:stale,entries:[],start:0,total:0,hasEarlier:false}}return {ref:worker,entries:[],start:0,total:0,hasEarlier:false}};
        const oldRead=f.v.readThreadForPane(stale.path); await started;
        f.t.applyThreadRef(worker);
        const newRead=await f.v.readThreadForPane(worker.path);
        f.t.applyThreadRef(internal);release();const retired=await oldRead;
        const result={calls,newWorker:newRead?.ref.nativeId===worker.nativeId,oldReturned:retired!==null,cache:f.v.rememberedThread(worker.path)?.ref.nativeId===worker.nativeId};
        const retiredOnly={...internal,path:'/fixture/fresh-reuse.jsonl',nativeId:'retired-only'};
        const fresh={...worker,path:retiredOnly.path,nativeId:'fresh-reader-worker'};
        f.t.applyThreadRef(retiredOnly);
        window.mako.pageThread=async ()=>({ref:fresh,entries:[],start:0,total:0,hasEarlier:false});
        result.freshWorker=(await f.v.readThreadForPane(fresh.path))?.ref.nativeId===fresh.nativeId;
        window.mako.pageThread=before;return result;
      })()`)
      await writeFile(join(root,"successor-results.json"),JSON.stringify(result,null,2))
      assert.deepEqual(result,{calls:2,newWorker:true,oldReturned:false,cache:true,freshWorker:true},"new worker owns a separate pane read at the reused path")
      const identities = await evaluate(`(() => {
        const f=reviewFixture,result=[];
        for(const variant of ['harness','identity','sessionId']) {
          const internal={...f.internal,path:'/fixture/'+variant+'.jsonl',nativeId:'identity-'+variant,sessionId:'old-session'};
          const worker={...internal,[variant]:variant==='harness'?'claude':variant==='identity'?'new-native-store':'new-session',nativeAgent:{kind:'unknown'},title:'New worker'};
          f.t.applyThreadRef(internal);f.t.applyThreadRef(worker);
          const view=f.v.viewedThread({ref:worker,entries:[]});f.v.rememberThread(view);f.tabs.openThreadTab(worker.path);f.t.threadsStore.set({viewing:view,opening:variant==='harness'?{kind:'loading',ref:internal}:null,composerHarness:internal.harness});
          f.t.applyThreadRef(internal);
          result.push({variant,view:f.t.threadsStore.get().viewing===view,cache:f.v.rememberedThread(worker.path)===view,tab:f.tabs.threadTabsStore.get().tabs.includes(worker.path),opening:f.t.threadsStore.get().opening===null,composer:variant!=='harness'||f.t.threadsStore.get().composerHarness===worker.harness});
        }return result;
      })()`)
      assert.ok(identities.every(result=>result.view&&result.cache&&result.tab&&result.opening&&result.composer),JSON.stringify(identities))
      console.log("PASS concurrent new worker read and harness/store/placed-session identity controls")
    }
    if (!only || only === "rail") {
      const rows = await evaluate("[...document.querySelectorAll('[data-thread-row]')].map(n=>n.textContent)")
      assert.ok(!rows.some(text => text.includes("Guardian review")), "internal review absent from rendered rail")
      assert.ok(rows.some(text => text.includes("Guardian worker conversation")), "worker named guardian still renders")
      assert.ok(rows.some(text => text.includes("Unknown source conversation")), "new unknown source still renders")
      await evaluate("window.dispatchEvent(new CustomEvent('mako:search-threads')); true")
      await until("Boolean(document.querySelector('input[placeholder=\"Search every thread\"]'))")
      await evaluate("(() => {const n=document.querySelector('input[placeholder=\"Search every thread\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'Guardian');n.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
      await until("document.querySelector('input[placeholder=\"Search every thread\"]').value === 'Guardian'")
      await frame()
      const found = await evaluate("[...document.querySelectorAll('[data-thread-row]')].map(n=>n.textContent)")
      assert.ok(!found.some(text=>text.includes('Guardian review')), "internal review absent from rendered search")
      assert.ok(found.some(text=>text.includes('Guardian worker conversation')), "worker remains searchable")
      console.log("PASS rail/search preserve worker and unknown source")
    }
    if (!only || only === "open") {
      await evaluate("reviewFixture.t.threads.view(reviewFixture.stale,'native').then(()=>true)")
      await frame()
      assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing?.ref.path === reviewFixture.internal.path"), false, "stale direct open cannot keep internal review in the viewer")
      assert.equal(await evaluate("reviewFixture.tabs.threadTabsStore.get().tabs.includes(reviewFixture.internal.path)"), false, "stale internal opened tab retired")
      assert.equal(await evaluate("Boolean(reviewFixture.v.rememberedThread(reviewFixture.internal.path))"), false, "internal transcript not cached as a conversation")
      console.log("PASS stale direct open retired after native metadata arrives")
    }
    if (!only || only === "late") {
      await evaluate(`(() => {const f=reviewFixture;f.v.rememberThread(f.v.viewedThread({ref:f.stale,entries:[]}));f.tabs.openThreadTab(f.stale.path);f.t.threadsStore.set({viewing:f.v.viewedThread({ref:f.stale,entries:[]})});f.t.applyThreadRef(f.internal);return true})()`)
      await frame()
      assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing?.ref.path === reviewFixture.internal.path"), false, "late classification retires historical open view")
      assert.equal(await evaluate("Boolean(reviewFixture.v.rememberedThread(reviewFixture.internal.path))"), false, "historical cached internal entry evicted")
      assert.equal(await evaluate("document.body.textContent.includes('This session has no readable conversation.')"), false, "internal review no longer shown as an empty conversation")
      console.log("PASS historical cached/open view reclassified")
      await evaluate(`(() => {const f=reviewFixture;f.v.rememberThread(f.v.viewedThread({ref:f.stale,entries:[]}));f.tabs.openThreadTab(f.stale.path);f.t.threadsStore.set({viewing:f.v.viewedThread({ref:f.stale,entries:[]})});f.t.applyThreads([f.internal,f.worker,f.unknown]);return true})()`)
      assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing?.ref.path === reviewFixture.internal.path"), false, "rehydration retires a restored internal view too")
    }
    await evaluate("reviewFixture.t.threads.view(reviewFixture.worker,'native').then(()=>true)")
    await until("document.body.textContent.includes('Ordinary worker prompt')", "real worker transcript")
    assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing.ref.nativeAgent.kind"), "agent")
    await evaluate("reviewFixture.t.threads.view(reviewFixture.internal).then(()=>true)")
    assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing.ref.path"), "/fixture/worker.jsonl", "a known internal open cannot displace an unrelated worker")
    await evaluate("reviewFixture.t.applyThreadRef(reviewFixture.internal); true")
    assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing.ref.path"), "/fixture/worker.jsonl", "a late internal update cannot close another conversation")
    await writeFile(join(root, "guardian-ui.png"), (await page.capturePage()).toPNG())
    console.log("PASS normal worker opens; internal history remains a host-owned record")
    const capped = await evaluate(`(() => {
      const f=reviewFixture;
      const internal=Array.from({length:700},(_,i)=>({...f.internal,path:'/fixture/cap-review-'+i,nativeId:'cap-review-'+i}));
      const workers=Array.from({length:601},(_,i)=>({...f.unknown,path:'/fixture/cap-worker-'+i,nativeId:'cap-worker-'+i,title:'Guardian worker '+i,model:'codex-auto-review',nativeAgent:i%2?{kind:'unknown',role:'guardian'}:{kind:'agent',role:'guardian'}}));
      f.t.applyThreads([...internal,...workers]);const rows=f.t.threadsStore.get().threads;
      return {count:rows.length,workersOnly:rows.every(ref=>ref.nativeId.startsWith('cap-worker-'))};
    })()`)
    assert.deepEqual(capped,{count:600,workersOnly:true},"internal reviews do not consume the rail cap or classify worker title/model/role")
    console.log("PASS 700 internal / 601 ordinary workers preserve 600 capped rows")
    guard.done()
    window.destroy()
    app.exit(0)
  } catch (error) {
    await writeFile(join(root, "failure.png"), (await page.capturePage()).toPNG())
    throw error
  }
}
