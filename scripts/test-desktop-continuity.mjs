import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

if (!process.versions.electron) {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-desktop-continuity-"))
  await mkdir(join(root, "workspace"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-continuity", main: fileURLToPath(import.meta.url) }))
  for (const name of ["node_modules", "dist-electron", "dist-browser-extension"])
    await symlink(resolve(name), join(root, name), "dir")
  const server = await createServer({ cacheDir: join(root, "cache"), define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" }, plugins: [manualDevUpdates()], server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  const env = { ...process.env, MAKO_CONTINUITY_ROOT: root, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MAKO_WEB_SOCKET
  delete env.MAKO_PROD
  try {
    for (const phase of ["live", "cold-resume", "legacy-resume"]) {
      if (phase === "legacy-resume") {
        const previous = JSON.parse(await readFile(join(root, "result.json"), "utf8"))
        assert.ok(previous.userData.startsWith(root + "/"))
        const db = new DatabaseSync(join(previous.userData, "conversations", `${previous.id}.sqlite`))
        try {
          const metadata = JSON.parse(db.prepare("SELECT value FROM metadata WHERE id=1").get().value)
          for (const binding of metadata.control.bindings) {
            delete binding.checkpoint
            binding.coveredBlocks = 0
          }
          db.prepare("UPDATE metadata SET value=? WHERE id=1").run(JSON.stringify(metadata))
        } finally {
          db.close()
        }
      }
      const child = childProcess.spawn(resolve("node_modules/.bin/electron"), [root, "--background"], { stdio: "inherit", env: {...env, MAKO_CONTINUITY_PHASE: phase} })
      process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)) })
      if (process.exitCode !== 0) break
    }
  } finally {
    await server.close()
  }
  console.log(`Desktop continuity evidence: ${root}`)
} else {
  void run().catch(async (error) => {
    console.error(error)
    const { app, powerMonitor } = await import("electron")
    powerMonitor.emit("shutdown")
    app.quit()
    app.exit(1)
  })
}

async function run() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_CONTINUITY_ROOT
  app.setPath("userData", join(root, "profile"))
  const children = []
  const originalSpawn = childProcess.spawn
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args)
    if (String(args[0]).endsWith("/devin") && args[1]?.includes("acp")) children.push(child)
    return child
  }
  syncBuiltinESMExports()
  const watchdog = setTimeout(() => {
    console.error("Desktop continuity test timed out")
    for (const child of children) child.kill()
    app.exit(1)
  }, 180_000)
  await import("../dist-electron/main.js")
  const until = async (read, predicate, label) => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const value = await read()
      if (predicate(value)) return value
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out: ${label}`)
  }
  const window = await until(async () => BrowserWindow.getAllWindows()[0], Boolean, "main window")
  await until(async () => window.webContents.isLoading(), (loading) => !loading, "renderer load")
  const evaluate = (expression) => window.webContents.executeJavaScript(expression)
  await until(() => evaluate(`Boolean(window.mako)`), Boolean, "preload")
  if (process.env.MAKO_CONTINUITY_PHASE !== "live") {
    const previous = JSON.parse(await readFile(join(root, "result.json"), "utf8"))
    await evaluate(`import('/src/state/acp.ts').then(({acp}) => acp.openRelated(${JSON.stringify(previous.id)}))`)
    const request = randomUUID()
    await evaluate(`window.mako.livePrompt(${JSON.stringify(previous.id)}, ${JSON.stringify(request)}, 'What was the exact PREVIEW_ marker in our last exchange? Reply only with that marker. Do not use tools.', [])`)
    const resumed = await until(() => evaluate(`window.mako.liveSnapshot(${JSON.stringify(previous.id)})`), (state) => state.requests.some((entry) => entry.id === request && ["completed", "failed", "uncertain"].includes(entry.status)), "cold resume receipt")
    const receipt = resumed.requests.find((entry) => entry.id === request)
    assert.equal(receipt.status, "completed", receipt.error)
    assert.equal(receipt.context?.length ?? 0, 0, "Native reconnect must not replay the saved transcript into itself")
    assert.equal(resumed.session.nativeId, previous.nativeId)
    assert.equal(resumed.session.currentMode, previous.mode)
    const latestUser = resumed.blocks.findLastIndex((block) => block.type === "user" && block.requestId === request)
    assert.ok(resumed.blocks.slice(latestUser + 1).some((block) => block.type === "text" && block.text.includes(previous.replyMarker)), "Cold restart must retain native context")
    await writeFile(join(root, `${process.env.MAKO_CONTINUITY_PHASE}.json`), JSON.stringify({nativeId:resumed.session.nativeId, mode:resumed.session.currentMode, contextRetained:true}, null, 2))
    console.log(`PASS: ${process.env.MAKO_CONTINUITY_PHASE} preserves native Devin identity, context, and mode across a full process restart`)
    await evaluate(`window.mako.liveClose(${JSON.stringify(previous.id)})`)
    app.once("will-quit", () => clearTimeout(watchdog))
    app.quit()
    return
  }
  const id = randomUUID()
  const requestId = randomUUID()
  const marker = `CONTINUITY_${randomUUID()}`
  const prompt = `Use your ask_user_question tool to ask me to choose Continue or Wait. After I answer Continue, reply with exactly ${marker}. This is a disposable UI lifecycle test. Do not read or change any files.`
  const options = { conversationId: id, modeId: "ask", tuning: { model: "gpt-6-astra-high" }, initialRequest: { id: requestId, text: prompt, attachments: [] } }
  await evaluate(`window.mako.liveStart('devin', ${JSON.stringify(join(root, "workspace"))}, ${JSON.stringify(options)})`)
  const snapshot = () => evaluate(`window.mako.liveSnapshot(${JSON.stringify(id)})`)
  await evaluate(`import('/src/state/acp.ts').then(({acp}) => acp.openRelated(${JSON.stringify(id)}))`)
  const waiting = await until(snapshot, (state) => state?.permissions?.some((permission) => permission.questions?.length), "Devin question")
  assert.equal(waiting.session.currentMode, "ask")
  const alive = await until(async () => children.filter((child) => child.exitCode === null && child.signalCode === null), (children) => children.length === 1, "owned provider process")
  const provider = alive[0]
  const rendererId = window.webContents.id
  app.quit()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(provider.exitCode, null)
  assert.equal(provider.signalCode, null)
  assert.equal(window.isDestroyed(), false)
  assert.equal((await snapshot()).session.status, "running")
  app.emit("activate")
  assert.equal(window.webContents.id, rendererId)
  window.hide()
  await evaluate("window.mako.openPreviewWindow()")
  const preview = BrowserWindow.getAllWindows().find((candidate) => candidate.id !== window.id)
  assert.ok(preview)
  const previewState = await preview.webContents.executeJavaScript(`window.mako.liveSnapshot(${JSON.stringify(id)})`)
  assert.equal(previewState.session.nativeId, waiting.session.nativeId)
  await until(() => preview.webContents.executeJavaScript(`import('/src/state/session.ts').then(({store}) => store.get().phase)`), (phase) => phase === "ready", "preview boot")
  const otherWorkspace = join(root, "other-workspace")
  await mkdir(otherWorkspace)
  await preview.webContents.executeJavaScript(`import('/src/state/session.ts').then(({actions}) => actions.newConversationIn(${JSON.stringify(otherWorkspace)}))`)
  const [parentBoot, previewBoot, parentGit, previewGit] = await Promise.all([
    evaluate("window.mako.boot()"), preview.webContents.executeJavaScript("window.mako.boot()"),
    evaluate("window.mako.gitStatus()"), preview.webContents.executeJavaScript("window.mako.gitStatus()"),
  ])
  assert.notEqual(parentBoot.activeTabId, previewBoot.activeTabId)
  assert.equal(parentGit.cwd, join(root, "workspace"))
  assert.equal(previewGit.cwd, otherWorkspace)
  const permission = waiting.permissions.find((permission) => permission.questions?.length)
  const answers = Object.fromEntries(permission.questions.map((question) => [question.id, [question.options[0]?.value ?? question.options[0]?.label ?? "Continue"]]))
  await preview.webContents.executeJavaScript(`window.mako.livePermission(${JSON.stringify(id)}, ${JSON.stringify(permission.id)}, ${JSON.stringify({ kind: "answers", answers })})`)
  const completed = await until(snapshot, (state) => state?.requests.some((request) => request.id === requestId && request.status === "completed"), "same agent completion after reopening")
  assert.equal(completed.session.nativeId, waiting.session.nativeId)
  assert.equal(completed.session.currentMode, "ask")
  assert.ok(completed.blocks.some((block) => block.type === "text" && block.text.includes(marker)))
  assert.equal(provider.exitCode, null)
  await preview.webContents.executeJavaScript(`import('/src/state/acp.ts').then(({acp}) => acp.openRelated(${JSON.stringify(id)}))`)
  const replyMarker = `PREVIEW_${randomUUID()}`
  await preview.webContents.executeJavaScript(`import('/src/state/acp.ts').then(({acp}) => acp.send(${JSON.stringify('Reply with exactly ' + replyMarker + '. Do not use tools.')}))`)
  const renderedReply = `import('/src/state/acp.ts').then(({acpStore,activeLiveAcp}) => activeLiveAcp(acpStore.get())?.blocks.some(block => block.type === 'text' && block.text.includes(${JSON.stringify(replyMarker)})))`
  await until(() => evaluate(renderedReply), Boolean, "preview reply appears in primary renderer")
  await until(() => preview.webContents.executeJavaScript(renderedReply), Boolean, "preview reply appears in preview renderer")
  await until(snapshot, (state) => state?.requests.at(-1)?.status === "completed", "preview follow-up completed")
  assert.equal((await snapshot()).session.nativeId, waiting.session.nativeId)
  assert.equal(provider.exitCode, null)
  console.log("PASS: answering from the preview and sending a follow-up updates both actual renderers without changing provider process or session")
  await writeFile(join(root, "result.json"), JSON.stringify({ id, replyMarker, userData: app.getPath("userData"), providerPid: provider.pid, rendererId, nativeId: completed.session.nativeId, mode: completed.session.currentMode, quitPreservedProcess: true, previewSharedHost: true, completedAfterReopen: true }, null, 2))
  console.log("PASS: actual Mako desktop kept the same Devin process, permission request, native session, and renderer through Quit/reopen; a second native window shared the host; the agent completed afterward")
  await until(snapshot, (state) => Boolean(state.requests.at(-1)?.snapshots?.after), "idle checkpoint before full quit")
  await until(snapshot, (state) => state.control.bindings.some((binding) => binding.id === state.control.activeBindingId && binding.checkpoint && binding.coveredBlocks === state.blocks.length), "native checkpoint before full quit")
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
  app.once("will-quit", () => clearTimeout(watchdog))
  app.quit()
}
