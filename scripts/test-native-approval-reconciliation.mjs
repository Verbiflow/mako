// Opt-in real-provider probe: writes only one nonce file in its disposable workspace.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-provider-e2e-approval-"))
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ main: fileURLToPath(import.meta.url) })
  )
  for (const name of ["node_modules", "dist-electron"])
    await symlink(resolve(name), join(root, name), "dir")
  const ui = process.argv.includes("--ui") ? await import("vite").then(({ createServer }) => createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })) : null
  await ui?.listen()
  const env = { ...process.env, MAKO_NATIVE_APPROVAL_ROOT: root, MAKO_NATIVE_APPROVAL_URL: ui?.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    resolve("node_modules/.bin/electron"),
    [root, ...process.argv.slice(2)],
    { env, stdio: "inherit" }
  )
  const deadline = setTimeout(() => child.kill("SIGTERM"), 300_000)
  child.once("exit", async (code) => {
    await ui?.close()
    clearTimeout(deadline)
    process.exitCode = code ?? 1
  })
} else {
  void run()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      const { app } = await import("electron")
      app.exit(process.exitCode ?? 0)
    })
}

async function run() {
  const { app, BrowserWindow, ipcMain } = await import("electron")
  let interrupted = false
  process.once("SIGTERM", () => {
    interrupted = true
  })
  const root = process.env.MAKO_NATIVE_APPROVAL_ROOT
  if (!root) throw new Error("Launch this probe with Node")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { providerHost } = await import("../dist-electron/providers/index.js")
  const { LiveConversations } =
    await import("../dist-electron/live-conversations.js")
  const { defaultCatalog } = await import("@mako/sessions")
  const { nativeSessionPath } = await import("../dist-electron/native-source.js")
  const catalog = defaultCatalog()
  const { bindAcp, stopAcp } = await import("../dist-electron/acp.js")
  const { bindCodexApp, stopCodexApps } =
    await import("../dist-electron/codex-app.js")
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const provider = requested.at(-1)
  const driver = providerHost.liveDrivers.get(provider)
  if (!driver) throw new Error("Supply one installed provider per invocation")
  const id = randomUUID()
  const cwd = join(root, "workspace")
  await mkdir(cwd)
  const access = process.env.MAKO_NATIVE_APPROVAL_ACCESS ?? "ask"
  const mode =
    driver.modes?.find((mode) => mode.access === access)?.id ??
    driver.defaultMode
  const events = []
  let answerDispatches = 0
  let dropDecisions = Boolean(process.env.MAKO_NATIVE_APPROVAL_RECONNECT)
  const observer = (event) => {
    if (event.type === "live-permission")
      events.push({
        type: event.type,
        requestId: event.request.id,
        observationId: event.request.observationId,
        kind: event.request.kind,
      })
    if (event.type === "live-permission-ended") events.push(event)
    if (event.type === "live-approval-decision") {
      events.push({ ...event, withheld: dropDecisions })
      if (dropDecisions) return
    }
    owner.observe(event)
  }
  const models = JSON.parse(process.env.MAKO_NATIVE_APPROVAL_MODELS ?? "{}")
  const observedDriver = {
    ...driver,
    async permission(id, requestId, response, dispatch) {
      answerDispatches++
      return driver.permission(id, requestId, response, process.env.MAKO_NATIVE_APPROVAL_DROP_SUBMISSION
        ? { ...dispatch, report() {} } : dispatch)
    },
    start: (path, options) =>
      driver.start(path, {
        ...options,
        emit: (event) => {
          if (event.type === "live-permission")
            events.push({
              type: event.type,
              requestId: event.request.id,
              observationId: event.request.observationId,
              kind: event.request.kind,
            })
          if (event.type === "live-permission-ended") events.push(event)
          if (event.type === "live-approval-decision") {
            events.push({ ...event, withheld: dropDecisions })
            if (dropDecisions) return
          }
          options.emit?.(event)
        },
      }),
  }
  const dependencies = {
    root: join(root, "journal"),
    appPath: root,
    driver: (name) => (name === provider ? observedDriver : undefined),
    history: async () => null,
    checkpoint: driver.checkpoint ? path => driver.checkpoint(path) : undefined,
    nativePath: session => nativeSessionPath(session, catalog.list()),
    resumeVerdict: driver.resumeVerdict ? binding => driver.resumeVerdict(binding) : undefined,
    emit() {},
    mcpSnapshot: async (path) => ({
      cwd: path,
      generatedAt: Date.now(),
      servers: [],
      providers: [],
    }),
  }
  let owner = new LiveConversations(dependencies)
  let page
  let renderedRevision
  const evidence = join(root, "visuals")
  await mkdir(evidence)
  const render = async snapshot => {
    if (!page || !snapshot || renderedRevision === snapshot.revision) return
    renderedRevision = snapshot.revision
    await page.executeJavaScript(`(async()=>{
      const {acpStore}=await import('/src/state/acp-state.ts');const {threadsStore}=await import('/src/state/thread-store.ts');const {applyLiveSnapshot}=await import('/src/state/live-recovery.ts');
      const snapshot=${JSON.stringify(snapshot)},key=acpStore.get().activeKey;
      threadsStore.set({composerHarness:snapshot.session.harness});
      window.mako.livePermission=(_id,requestId,response)=>window.nativeApproval.send(requestId,response);
      window.nativeSnapshot={...snapshot,session:{...snapshot.session,id:key},permissions:snapshot.permissions.map(p=>({...p,sessionId:key})),epoch:'native-ui-proof'};
      window.mako.liveSnapshot=async()=>{const current=await window.nativeApproval.snapshot();return {...current,session:{...current.session,id:key},permissions:current.permissions.map(p=>({...p,sessionId:key})),epoch:'native-ui-proof'}};
      applyLiveSnapshot(window.nativeSnapshot);
    })()`)
  }
  const capture = async name => {
    if (!page) return
    await new Promise(resolve=>setTimeout(resolve,350))
    await writeFile(join(evidence,name+'.png'),(await page.capturePage()).toPNG())
  }
  if (process.env.MAKO_NATIVE_APPROVAL_URL) {
    const preload = join(root,'native-approval.cjs')
    await writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeApproval',{send:(requestId,response)=>ipcRenderer.invoke('native-approval',requestId,response),snapshot:()=>ipcRenderer.invoke('native-approval-snapshot')});`)
    ipcMain.handle('native-approval',(_event,requestId,response)=>owner.permission(id,requestId,response))
    ipcMain.handle('native-approval-snapshot',()=>owner.snapshot(id))
    const window = new BrowserWindow({show:true,width:1120,height:840,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
    page = window.webContents
    page.debugger.attach('1.3')
    await window.loadURL(process.env.MAKO_NATIVE_APPROVAL_URL+'scripts/live-workflow.html?native')
    const deadline=Date.now()+20_000
    while(!await page.executeJavaScript("Boolean(document.querySelector('.composer-input'))")) {
      if(Date.now()>deadline) throw Error('Composer did not load')
      await new Promise(resolve=>setTimeout(resolve,100))
    }
  }
  bindAcp(observer)
  bindCodexApp(observer)
  const result = { provider, mode, approvalEvidence: driver.approvalEvidence, root, cases: [], events }
  const wait = async (predicate, handle, ms = 90_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (interrupted) throw new Error("Native probe interrupted")
      const snapshot = owner.snapshot(id)
      if (snapshot?.session.status === "failed")
        throw new Error(snapshot.session.error ?? "Provider failed")
      const transfer = snapshot?.control?.transfers.at(-1)
      if (transfer?.state.kind === "failed") throw new Error(transfer.state.error)
      if (snapshot?.permissions.some((p) => p.kind === "authentication"))
        throw new Error(
          "Native probe requires an already authenticated account"
        )
      await render(snapshot)
      if (handle) await handle(snapshot)
      if (predicate(snapshot)) return snapshot
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("Native approval probe deadline")
  }
  try {
    await owner.start(provider, cwd, {
      conversationId: id,
      title: "Mako disposable native approval probe",
      modeId: mode,
      tuning: models[provider] ? { model: models[provider] } : undefined,
    })
    await wait((s) => s?.session.status === "ready")
    result.nativeId = owner.snapshot(id).session.nativeId
    if (provider === "opencode") {
      await owner.setMode(id, "plan")
      if (owner.snapshot(id).session.currentMode !== "plan") throw Error("Native Plan selection was not observed")
      await owner.setMode(id, mode)
      if (owner.snapshot(id).session.currentMode !== mode) throw Error("Native Build preset was not restored")
      result.planRoundTrip = true
    }
    for (const decision of ["deny", "allow"]) {
      const nonce = randomUUID()
      const path = join(cwd, decision + ".txt")
      const command = `printf '%s' '${nonce}' >> '${path}'`
      const request = randomUUID()
      const seen = new Set()
      const record = {
        decision,
        nonce,
        approvals: 0,
        expectedFile: decision === "allow",
      }
      result.cases.push(record)
      owner.submit(
        id,
        request,
        `This is a harmless approval test in a disposable fixture. Use your shell tool exactly once to run this command: ${command}\nDo not run any other commands or edit any other files. Request approval if needed. If denied, do not retry or use another tool. Finish with a brief status.`
      )
      let done = await wait(
        (s) =>
          s?.requests.some(
            (r) =>
              r.id === request &&
              ["completed", "failed", "canceled", "interrupted"].includes(r.status)
          ),
        async (snapshot) => {
          for (const permission of snapshot?.permissions ?? []) {
            if (seen.has(permission.id)) continue
            seen.add(permission.id)
            record.approvals++
            // Grant only a prompt displaying our exact disposable command/file.
            const scoped =
              permission.title.includes(nonce) ||
              permission.title.includes(path)
            const choice = permission.options.find(
              (option) =>
                option.kind ===
                (decision === "allow" && scoped ? "allow_once" : "reject_once")
            )
            if (!scoped && decision === "allow") record.unscopedRefusal = true
            if (page && choice) {
              await capture(access+'-'+decision+'-pending')
              const label=JSON.stringify(choice.name)
              const point=await page.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${label} && b.getClientRects().length);if(!button)throw Error('Native approval button missing');const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
              for(const type of ['mousePressed','mouseReleased']) await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
            } else await owner.permission(id, permission.id, {
              kind: "choice", optionId: choice?.optionId ?? null,
            }).catch(error => { if (!process.env.MAKO_NATIVE_APPROVAL_DROP_SUBMISSION) throw error })
          }
        }
      )
      if (driver.approvalEvidence.kind === "native-decisions" && record.approvals && !dropDecisions) {
        done = await wait(s => [...seen].every(id => s?.control?.approvalResponses?.some(receipt => receipt.id === id && receipt.nativeDecision?.answerDigest === receipt.digest)), undefined, 5000)
        record.nativeDecisionsConfirmed = true
      }
      const content = await readFile(path, "utf8").catch(() => null)
      record.fileMatches = content === nonce
      record.receipts = done.control?.approvalResponses ?? []
      record.status =
        record.approvals === 0
          ? "no-interactive-approval-observed"
          : record.fileMatches === record.expectedFile &&
              !record.unscopedRefusal
            ? "passed"
            : "failed"
      await render(done)
      await capture(access+"-"+decision+"-completed")
      if (page && record.nativeDecisionsConfirmed) {
        const point=await page.executeJavaScript("(()=>{const r=document.querySelector('button[aria-label=\"Conversation actions\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
        for(const type of ['mousePressed','mouseReleased']) await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
        await capture(access+'-'+decision+'-native-decision')
        if (!await page.executeJavaScript("document.body.textContent.includes('Agent recorded your answer')")) throw Error('Native decision did not reach approval history UI')
        await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
        await page.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
      }
      console.log(JSON.stringify({ provider, ...record }))
    }
    if (dropDecisions) {
      await catalog.scan()
      owner.discoverNativePaths()
      const before = owner.snapshot(id)
      const sentAnswers = answerDispatches
      if (!before.control.approvalResponses.every(r => r.origin.native && !r.nativeDecision)) throw Error('Lost-event test did not retain unresolved native identities')
      if (!owner.hibernateIfIdle(id)) throw Error('Disposable session could not hibernate')
      await wait(s => s?.session.connection === 'hibernated', undefined, 20_000)
      owner.stop()
      dropDecisions = false
      owner = new LiveConversations(dependencies)
      const followup = randomUUID()
      owner.submit(id, followup, 'Do not run any tools. Reply with only: reconnected')
      const resumed = await wait(s => s?.requests.some(r => r.id === followup && r.status === 'completed') && s.control?.approvalResponses?.every(r => r.nativeDecision?.answerDigest === r.digest))
      if (resumed.session.nativeId !== result.nativeId) throw Error('Reconnect changed native session')
      const allowed = await readFile(join(cwd,'allow.txt'),'utf8')
      if (allowed !== result.cases.find(item => item.decision === 'allow').nonce) throw Error('Approval operation executed more than once')
      if (await readFile(join(cwd,'deny.txt'),'utf8').catch(()=>null) !== null) throw Error('Denied operation executed after reconnect')
      if (answerDispatches !== sentAnswers) throw Error('Reconnect replayed an approval answer')
      result.reconnect = { sameSession: true, receipts: resumed.control.approvalResponses, answersReplayed: false, answerDispatches, allowedOperationCount: 1, deniedOperationCount: 0 }
      await render(resumed)
      await capture('reconnected-native-evidence')
      if (page) {
        const point = await page.executeJavaScript("(()=>{const r=document.querySelector('button[aria-label=\"Conversation actions\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
        for (const type of ['mousePressed','mouseReleased']) await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
        if (!await page.executeJavaScript("document.body.textContent.includes('Agent recorded your answer')")) throw Error('Recovered native decision did not reach approval history UI')
        await capture('reconnected-approval-history')
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    console.log(JSON.stringify({ provider, error: result.error }))
  } finally {
    const final = owner.snapshot(id)
    result.final = final
      ? {
          session: final.session,
          requests: final.requests.map((r) => ({
            id: r.id,
            status: r.status,
            failure: r.failure,
            error: r.error,
          })),
          receipts: final.control?.approvalResponses,
        }
      : undefined
    result.nativeId ??= final?.session.nativeId
    await owner.close(id).catch(() => {})
    owner.stop()
    stopAcp()
    stopCodexApps()
    if (result.nativeId) {
      const catalog = defaultCatalog()
      for (const ref of await catalog.scan()) {
        if (ref.harness === provider && ref.nativeId === result.nativeId)
          result.nativeCleanup = await catalog.remove(ref.path)
      }
    }
    await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
    console.log("Native evidence: " + join(root, "result.json"))
    process.exitCode = result.error || result.cases.some(item => item.status === "failed") ? 1
      : result.cases.some(item => item.status !== "passed") ? 2 : 0
  }
}
