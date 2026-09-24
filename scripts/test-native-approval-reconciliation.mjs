// Opt-in real-provider probe: permitted writes are nonce files in its disposable workspace.
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
  const { nativeCheckpoint, resumeVerdict } = await import("../dist-electron/native-continuation.js")
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
          if (event.type === "live-approval-decision") events.push({ type: "before-native-decision", permissions: owner.snapshot(id)?.permissions.map(p => ({ id: p.id, origin: p.origin })) })
          options.emit?.(event)
          if (event.type === "live-approval-decision") events.push({ type: "after-native-decision", resolutions: owner.snapshot(id)?.control?.approvalObservations, permissions: owner.snapshot(id)?.permissions.map(p => p.id) })
        },
      }),
  }
  const dependencies = {
    root: join(root, "journal"),
    appPath: root,
    driver: (name) => (name === provider ? observedDriver : undefined),
    history: async () => null,
    checkpoint: path => driver.checkpoint ? driver.checkpoint(path) : nativeCheckpoint(path),
    nativePath: session => nativeSessionPath(session, catalog.list()),
    resumeVerdict: binding => driver.resumeVerdict ? driver.resumeVerdict(binding) : resumeVerdict(binding, providerHost.processProbes.get(binding.provider)),
    emit() {},
    mcpSnapshot: async (path) => ({
      cwd: path,
      generatedAt: Date.now(),
      servers: [],
      providers: [],
    }),
  }
  let owner = new LiveConversations(dependencies)
  const externalDecision = Boolean(process.env.MAKO_NATIVE_APPROVAL_EXTERNAL)
  const externalIdentities = new Map()
  const sendApproval = async (requestId, response) => {
    if (!externalDecision) return owner.permission(id, requestId, response)
    const pending = owner.snapshot(id)?.permissions.find(item => item.id === requestId)
    if (!pending?.origin?.native) throw Error('External decision probe requires exact native request identity')
    externalIdentities.set(requestId, pending.origin.native)
    // A separate controller answers the real native callback. Mako's owner has
    // no local answer intent; only the native observer can settle its question.
    await driver.permission(pending.origin.bindingId, pending.origin.nativeRequestId, response, {
      assertCurrent() {
        if (!owner.snapshot(id)?.permissions.some(item => item.id === requestId)) throw Error('External probe request is no longer current')
      },
      report() {},
    })
  }

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
    ipcMain.handle('native-approval',(_event,requestId,response)=>sendApproval(requestId,response))
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
      modeId: process.env.MAKO_NATIVE_APPROVAL_CHECK_INHERITED ? undefined : mode,
      tuning: models[provider] ? { model: models[provider] } : undefined,
    })
    await wait((s) => s?.session.status === "ready")
    result.nativeId = owner.snapshot(id).session.nativeId
    if (process.env.MAKO_NATIVE_APPROVAL_CHECK_INHERITED) {
      const session = owner.snapshot(id).session
      result.inheritedMode = session.currentMode
      if (session.currentMode !== process.env.MAKO_NATIVE_APPROVAL_CHECK_INHERITED) throw Error('Native inherited policy was not reported accurately')
      await capture('inherited-policy')
      await owner.setMode(id, mode)
    }
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
            const choice = decision === "allow" && scoped
              ? permission.options.find(option => option.kind === "allow_once")
              : permission.options.find(option => option.kind === "reject_once") ?? permission.options.find(option => option.kind === "reject_always")
            if (!choice) throw Error('Native runtime offered no applicable approval choice')
            record.nativeChoice = { id: choice.optionId, name: choice.name, kind: choice.kind }
            if (!scoped && decision === "allow") record.unscopedRefusal = true
            if (page && choice) {
              await capture(access+'-'+decision+'-pending')
              const label=JSON.stringify(choice.name)
              const point=await page.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${label} && b.getClientRects().length);if(!button)throw Error('Native approval button missing');const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
              for(const type of ['mousePressed','mouseReleased']) await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
            } else await sendApproval(permission.id, {
              kind: "choice", optionId: choice?.optionId ?? null,
            }).catch(error => { if (!process.env.MAKO_NATIVE_APPROVAL_DROP_SUBMISSION) throw error })
          }
        }
      )
      if (driver.approvalEvidence.kind === "native-decisions" && record.approvals && !dropDecisions) {
        done = await wait(s => [...seen].every(id => externalDecision
          ? s?.control?.approvalObservations?.some(item => JSON.stringify(item.decision?.identity) === JSON.stringify(externalIdentities.get(id)))
          : s?.control?.approvalResponses?.some(receipt => receipt.id === id && receipt.nativeDecision?.answerDigest === receipt.digest)), undefined, 5000)
        record.nativeDecisionsConfirmed = !externalDecision
        if (externalDecision) {
          record.externalResolutions = done.control.approvalObservations
          if (done.permissions.length || done.control.approvalResponses?.length) throw Error('External native decision left a question or fabricated a local answer')
        }
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
    if (process.env.MAKO_NATIVE_APPROVAL_QUESTIONS) {
      const questionMode = process.env.MAKO_NATIVE_QUESTION_MODE
      if (questionMode) await owner.setMode(id, driver.modes?.find(item=>item.access===questionMode)?.id ?? questionMode)
      const request = randomUUID()
      owner.submit(id, request, 'Use your native structured question or user-input tool to ask exactly one question: "What is the verification phrase?" Allow a free-text answer (an Other option is fine). Wait for the answer, then reply with exactly that phrase. Do not ask in plain text, guess the phrase, run commands, read files, or call any other tools.')
      const asked = await wait(s => s?.permissions.length || s?.requests.some(r => r.id === request && ['completed', 'failed', 'interrupted'].includes(r.status)))
      const permission = asked.permissions[0]
      if (!permission?.questions?.length || permission.questions.length !== 1) throw Error('Native runtime did not emit the requested single structured question')
      const question = permission.questions[0]
      if (question.options.length && !question.allowOther) throw Error('Native question did not allow a verification phrase')
      // Generate after the native question arrived. The only path by which the
      // runtime can learn this value is the answer to this exact occurrence.
      const phrase = `ANSWER_${randomUUID()}`
      const sentBefore = answerDispatches
      await capture('question-pending')
      if (page) {
        const point = await page.executeJavaScript("(()=>{const input=[...document.querySelectorAll('fieldset input')].find(e=>e.getClientRects().length);if(!input)throw Error('Native question input missing');const r=input.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
        for (const type of ['mousePressed','mouseReleased']) await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
        await page.debugger.sendCommand('Input.insertText',{text:phrase})
        await capture('question-answer-draft')
        const submit = await page.executeJavaScript("(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Send answers'&&e.getClientRects().length);if(!b||b.disabled)throw Error('Question answer is not ready');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
        for (const type of ['mousePressed','mouseReleased']) await page.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...submit})
      } else await sendApproval(permission.id,{kind:'answers',answers:{[question.id]:[phrase]}})
      const answered = await wait(s => s?.requests.some(r=>r.id===request&&r.status==='completed'))
      const start = answered.blocks.findIndex(b=>b.type==='user'&&b.requestId===request)
      const response = answered.blocks.slice(start+1).filter(b=>b.type==='text').map(b=>b.text).join('')
      if (start < 0 || !response.includes(phrase)) throw Error('Native continuation did not consume the submitted verification phrase')
      if (answerDispatches !== sentBefore+1 || answered.permissions.some(p=>p.id===permission.id)) throw Error('Question answer dispatched more than once or stayed pending')
      const receipt = answered.control?.approvalResponses?.find(r=>r.id===permission.id)
      if (!receipt) throw Error('Structured answer receipt was not retained')
      result.question = {requestId:request,approvalId:permission.id,phrase,continuationContainsAnswer:true,dispatches:1,receipt}
      await render(answered)
      await capture('question-completed')
      if (questionMode) await owner.setMode(id,mode)
    }
    if (process.env.MAKO_NATIVE_APPROVAL_CANCEL) {
      const cancelNonce = randomUUID(), cancelPath = join(cwd, 'cancelled.txt'), request = randomUUID()
      owner.submit(id, request, `In this disposable fixture, request approval to execute exactly: printf '%s' '${cancelNonce}' >> '${cancelPath}'. Do not run any other command or write any other file.`)
      await wait(s => s?.permissions.some(p => p.title.includes(cancelNonce) || p.title.includes(cancelPath)))
      await capture('cancel-pending')
      const sentBeforeCancel = answerDispatches
      await owner.cancel(id)
      const cancelled = await wait(s => !s?.permissions.length && s?.requests.some(r => r.id === request && ['canceled', 'interrupted'].includes(r.status)))
      if (await readFile(cancelPath, 'utf8').catch(() => null) !== null) throw Error('Cancelled pending operation executed')
      if (answerDispatches !== sentBeforeCancel) throw Error('Cancellation dispatched an approval answer')
      result.cancellation = { requestStatus: cancelled.requests.find(r => r.id === request).status, questionRemoved: true, fileAbsent: true, answerDispatched: false }
      await render(cancelled)
      await capture('cancel-completed')
    }
    if (dropDecisions || process.env.MAKO_NATIVE_APPROVAL_REOPEN) {
      const requireNativeDecisions = dropDecisions
      await catalog.scan()
      owner.discoverNativePaths()
      const before = owner.snapshot(id)
      const sentAnswers = answerDispatches
      if (requireNativeDecisions && !before.control.approvalResponses.every(r => r.origin.native && !r.nativeDecision)) throw Error('Lost-event test did not retain unresolved native identities')
      // Some native Stop implementations already close their transport. Reopen
      // that retained session directly; only connected sessions need hibernation.
      if (before.session.connection === 'connected') {
        if (!owner.hibernateIfIdle(id)) throw Error('Disposable session could not hibernate')
        await wait(s => s?.session.connection === 'hibernated', undefined, 20_000)
      } else if (before.session.connection !== 'disconnected' || before.session.status !== 'ready') {
        throw Error('Disposable session is not ready for owner reopen')
      }
      owner.stop()
      dropDecisions = false
      owner = new LiveConversations(dependencies)
      const followup = randomUUID()
      owner.submit(id, followup, 'Do not run any tools. Reply with only: reconnected')
      const resumed = await wait(s => s?.requests.some(r => r.id === followup && r.status === 'completed') && (!requireNativeDecisions || s.control?.approvalResponses?.every(r => r.nativeDecision?.answerDigest === r.digest)))
      if (resumed.session.nativeId !== result.nativeId) throw Error('Reconnect changed native session')
      const followupStart = resumed.blocks.findIndex(block => block.type === 'user' && block.requestId === followup)
      if (followupStart < 0 || !resumed.blocks.slice(followupStart + 1).filter(block => block.type === 'text').map(block => block.text).join('').includes('reconnected')) throw Error('Reconnect did not produce the requested visible answer')
      for (const item of result.cases) {
        const content = await readFile(join(cwd, `${item.decision}.txt`), 'utf8').catch(() => null)
        if (content !== (item.fileMatches ? item.nonce : null)) throw Error(`Reconnect changed ${item.decision} execution count`)
      }
      if (answerDispatches !== sentAnswers) throw Error('Reconnect replayed an approval answer')
      if (externalDecision && JSON.stringify(resumed.control?.approvalObservations) !== JSON.stringify(before.control?.approvalObservations)) throw Error('Reconnect lost external native resolutions')
      const priorReceipts = before.control?.approvalResponses ?? []
      for (const prior of priorReceipts) {
        const retained = resumed.control?.approvalResponses?.find(receipt => receipt.id === prior.id)
        if (!retained || retained.digest !== prior.digest) throw Error('Reconnect lost an approval receipt')
        if (!requireNativeDecisions && !prior.nativeDecision && retained.nativeDecision) throw Error('Reconnect fabricated native decision evidence')
      }
      result.reconnect = { priorConnection: before.session.connection, sameSession: true, receipts: resumed.control?.approvalResponses, answersReplayed: false, answerDispatches, executionCountsUnchanged: true, exactNativeDecisions: requireNativeDecisions }
      await render(resumed)
      await capture('reconnected-native-evidence')
      if (page && requireNativeDecisions) {
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
          resolutions: final.control?.approvalObservations,
          permissions: final.permissions,
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
