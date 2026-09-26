import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import WebSocket from "ws"
import { z } from "zod"
import { extractFile } from "@electron/asar"
import { assertPackagedImports } from "./test-packaged-imports.mjs"

const StartupTraceSchema = z.object({
  stage: z.enum(["local-control", "profile", "accepted", "discovery"]),
  elapsedMs: z.number().nonnegative(),
  command: z.string().optional(),
  queuedMs: z.number().nonnegative().optional(),
  resolveMs: z.number().nonnegative().optional(),
})
const approvalChecks = process.argv.includes("--approvals")
const rendererOnly = process.argv.includes("--renderer-only")
const warmStart = process.argv.includes("--warm")
const uiStart = process.argv.includes("--ui-start")
const stopCheck = process.argv.includes("--stop")
const terminalCheck = process.argv.includes("--terminal")
const searchCheck = process.argv.includes("--search")
const modelFlag = process.argv.find((arg) => arg.startsWith("--model="))
const selectedModel = modelFlag?.slice(8)
const args = process.argv
  .slice(2)
  .filter(
    (arg) =>
      arg !== "--renderer-only" &&
      arg !== "--approvals" &&
      arg !== "--warm" &&
      arg !== "--ui-start" &&
      arg !== "--stop" &&
      arg !== "--terminal" &&
      arg !== "--search" &&
      arg !== modelFlag
  )
assert.ok(
  args.length <= 2,
  "Use [Mako.app] [provider] [--renderer-only] [--warm] [--model=id] [--ui-start] [--stop] [--terminal] [--search]"
)
const acceptanceBudget =
  process.env.MAKO_STARTUP_BUDGET_MS === undefined
    ? null
    : Number(process.env.MAKO_STARTUP_BUDGET_MS)
assert.ok(
  acceptanceBudget === null ||
    (Number.isFinite(acceptanceBudget) && acceptanceBudget > 0)
)
const app = resolve(args[0] ?? "/tmp/mako-parity-package/mac-arm64/Mako.app")
const provider = args[1] ?? "claude"
assert.ok(
  !uiStart || (provider === "claude" && !selectedModel && !rendererOnly),
  "UI startup checks the fresh profile's Claude defaults"
)
const root = await mkdtemp(join(tmpdir(), "mako-packaged-lifecycle-"))
const workspace = join(root, "workspace")
await mkdir(workspace)
await writeFile(
  join(workspace, "README.md"),
  "Disposable package verification workspace.\n"
)
const executable = join(app, "Contents/MacOS/Mako")
let conversationId = randomUUID()
const marker = `PACKAGE_${randomUUID().replaceAll("-", "")}`
const report = {
  app,
  provider: rendererOnly ? null : provider,
  root,
  outcome: "running",
  hostMode: "isolated-standalone",
  phases: [],
}
const soakMs = Number(
  process.env.MAKO_PACKAGE_SOAK_MS ?? (rendererOnly ? 30_000 : 0)
)
assert.ok(Number.isFinite(soakMs) && soakMs >= 0 && soakMs <= 900_000)
const memorySampler = join(root, "memory-sample")
if (soakMs)
  execFileSync("clang", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    resolve("scripts/memory-sample.c"),
    "-o",
    memorySampler,
  ])
let child
let socket
let counter = 0
const callbacks = new Map()
let launchError

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++counter
    const timer = setTimeout(() => {
      callbacks.delete(id)
      reject(new Error(`Timed out: ${method}`))
    }, 120_000)
    callbacks.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.exceptionDetails)
    throw new Error(JSON.stringify(response.exceptionDetails))
  return response.result.value
}
async function waitFor(read, predicate, label, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    if (child?.exitCode !== null || child?.signalCode)
      throw new Error(
        `Package exited during ${label}: code=${child?.exitCode}, signal=${child?.signalCode}`
      )
    const value = await read()
    if (predicate(value)) return value
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function startPackage() {
  await rm(join(root, "profile/DevToolsActivePort"), { force: true })
  launchError = undefined
  const env = {
    ...process.env,
    MAKO_BACKEND_URL: "http://127.0.0.1:9/api/mcp",
    MAKO_BACKEND_TOKEN: "",
    MAKO_STANDALONE: "1",
    MAKO_DATA_ROOT: join(root, "profile"),
    MAKO_CURSOR_SDK_ROOT: join(root, "cursor"),
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.VITE_DEV_SERVER_URL
  delete env.MAKO_WEB_SOCKET
  delete env.MAKO_HOST_ONLY
  delete env.MAKO_WEB_ONLY
  child = spawn(
    executable,
    [
      `--user-data-dir=${join(root, "profile")}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
    ],
    { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  )
  child.stderr.resume()
  let traceBuffer = ""
  child.stdout.on("data", (chunk) => {
    traceBuffer = (traceBuffer + chunk.toString()).slice(-8192)
    const lines = traceBuffer.split("\n")
    traceBuffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("[mako-startup] ")) continue
      let value
      try {
        value = JSON.parse(line.slice(15))
      } catch {
        continue
      }
      const trace = StartupTraceSchema.safeParse(value)
      if (trace.success) {
        report.phases.push({ phase: "startup-trace", ...trace.data })
        console.log(
          `Startup ${trace.data.stage}: ${Math.round(trace.data.elapsedMs)} ms`
        )
      }
    }
  })
  child.once("error", (error) => {
    launchError = error
  })
  const port = await waitFor(
    async () => {
      try {
        return Number(
          (
            await readFile(join(root, "profile/DevToolsActivePort"), "utf8")
          ).split("\n")[0]
        )
      } catch {
        return 0
      }
    },
    Boolean,
    "debugger"
  )
  const target = await waitFor(
    async () => {
      try {
        return (
          await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        ).find((item) => item.type === "page" && item.url.startsWith("mako-app:"))
      } catch {
        return null
      }
    },
    Boolean,
    "packaged renderer"
  )
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString())
    if (message.id) {
      const callback = callbacks.get(message.id)
      callbacks.delete(message.id)
      callback?.(message)
    }
  })
  await waitFor(
    () =>
      evaluate(
        "Boolean(window.mako && document.querySelector('.composer-input'))"
      ),
    Boolean,
    "preload and composer"
  )
  return { url: target.url, pid: child.pid }
}
async function stopPackage() {
  socket?.close()
  socket = undefined
  if (child && child.exitCode === null) {
    process.kill(-child.pid, "SIGTERM")
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5000),
    ])
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      /* The owned process group has exited. */
    }
  }
  child = undefined
}
const bridge = (name, args) =>
  evaluate(`window.mako[${JSON.stringify(name)}](...${JSON.stringify(args)})`)
async function memorySample() {
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
  const owned = new Set([child.pid])
  for (let previous = 0; previous !== owned.size;) {
    previous = owned.size
    for (const [pid, parent] of processes) if (owned.has(parent)) owned.add(pid)
  }
  assert.ok(
    owned.size <= 128,
    "Owned process count exceeded the verification budget"
  )
  const measured = JSON.parse(
    execFileSync(memorySampler, [...owned].map(String), {
      encoding: "utf8",
      timeout: 5000,
    })
  )
  for (const item of measured) {
    if (item.error === undefined) continue
    try {
      process.kill(item.pid, 0)
      item.processState = execFileSync(
        "ps",
        ["-p", String(item.pid), "-o", "stat=", "-o", "uid=", "-o", "comm="],
        { encoding: "utf8", timeout: 5000 }
      ).trim()
      if (item.processState.startsWith("Z")) item.exited = true
      item.privilegedProbe =
        item.error === 1 &&
        /^\S+\s+\d+\s+(?:\/bin\/)?ps$/.test(item.processState)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        item.exited = true
      else if (
        error instanceof Error &&
        "status" in error &&
        error.status === 1
      ) {
        try {
          process.kill(item.pid, 0)
        } catch (probeError) {
          if (
            probeError instanceof Error &&
            "code" in probeError &&
            probeError.code === "ESRCH"
          )
            item.exited = true
          else throw probeError
        }
      } else throw error
    }
  }
  const pressure = execFileSync("memory_pressure", ["-Q"], {
    encoding: "utf8",
    timeout: 5000,
  })
  const free = /System-wide memory free percentage:\s*(\d+)%/.exec(pressure)
  assert.ok(free, "System memory pressure was unavailable")
  return {
    at: Date.now(),
    rssBytes: processes
      .filter(([pid]) => owned.has(pid))
      .reduce((sum, [, , rss]) => sum + rss * 1024, 0),
    unmeasuredPhysicalProcesses: measured.filter(
      (item) => item.error !== undefined && !item.exited
    ),
    measuredPhysicalFootprintBytes: measured.reduce(
      (sum, item) => sum + (item.physicalFootprintBytes ?? 0),
      0
    ),
    memoryFreePercent: Number(free[1]),
    processCount: owned.size,
    processes: measured,
    renderer: await command("Runtime.getHeapUsage"),
  }
}
async function soak() {
  if (!soakMs) return
  const draft = `Package reload draft ${randomUUID()}`
  await waitFor(
    () =>
      evaluate(
        "Boolean(document.querySelector('.composer-input:not([readonly])'))"
      ),
    Boolean,
    "workspace draft target"
  )
  await evaluate("document.querySelector('.composer-input').focus()")
  await command("Input.insertText", { text: draft })
  const draftState = () =>
    evaluate(`({
    value: document.querySelector('.composer-input')?.value,
    focused: document.activeElement?.className,
    stored: localStorage.getItem('mako.session-drafts.v1')
  })`)
  report.phases.push({
    phase: "draft-before-reload",
    state: await draftState(),
  })
  await waitFor(
    () => evaluate("document.querySelector('.composer-input')?.value"),
    (value) => value === draft,
    "trusted draft input"
  )
  const samples = []
  const started = Date.now()
  const phase = {
    phase: "renderer-reload-soak",
    physicalCoverage:
      "Mako and measurable children; privileged ps readings are explicitly unavailable",
    elapsedMs: 0,
    reloads: 0,
    samples,
  }
  report.phases.push(phase)
  while (Date.now() - started < soakMs) {
    const beforeReload = await evaluate("performance.timeOrigin")
    await command("Page.reload")
    await waitFor(
      () =>
        evaluate(
          `performance.timeOrigin !== ${beforeReload} && document.querySelector('.composer-input')?.value === ${JSON.stringify(draft)}`
        ).catch(() => false),
      Boolean,
      "draft recovery after packaged renderer reload"
    ).catch(async (error) => {
      report.phases.push({
        phase: "draft-reload-failure",
        state: await draftState(),
      })
      throw error
    })
    phase.reloads++
    const sample = await memorySample()
    samples.push(sample)
    phase.elapsedMs = Date.now() - started
    assert.ok(
      sample.processes.some(
        (item) =>
          item.pid === child.pid && item.physicalFootprintBytes !== undefined
      ),
      "Host physical footprint was unavailable"
    )
    assert.ok(
      sample.processes.every(
        (item) =>
          item.error === undefined ||
          item.error === 3 ||
          item.exited ||
          item.privilegedProbe
      ),
      "Physical footprint sampling was denied or failed"
    )
    assert.ok(
      sample.memoryFreePercent >= 10,
      "Stopped the soak because system memory pressure is too high"
    )
    assert.ok(
      sample.measuredPhysicalFootprintBytes <= 4 * 1024 ** 3,
      "Measured physical footprint exceeded the 4 GiB safety limit"
    )
    assert.ok(
      sample.rssBytes <= 4 * 1024 ** 3,
      "Full process-tree RSS exceeded the 4 GiB safety limit"
    )
    if (phase.reloads % 6 === 0)
      console.log(
        `Packaged soak: ${phase.reloads} reloads, ${Math.round(sample.measuredPhysicalFootprintBytes / 1024 ** 2)} MiB measured physical footprint, draft preserved`
      )
    await delay(10_000)
  }
  phase.elapsedMs = Date.now() - started
  if (samples.length >= 30) {
    const median = (items) =>
      items
        .map((item) => item.measuredPhysicalFootprintBytes)
        .sort((a, b) => a - b)[Math.floor(items.length / 2)]
    const baseline = median(samples.slice(6, 12))
    const final = median(samples.slice(-6))
    phase.steadyState = {
      baselineBytes: baseline,
      finalBytes: final,
      growthBytes: final - baseline,
    }
    assert.ok(
      final - baseline <= Math.max(256 * 1024 ** 2, baseline * 0.25),
      "Physical footprint grew beyond the steady-state budget"
    )
  }
}
async function captureConversation(name) {
  const selector = `[data-conversation-id="${conversationId}"]`
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), Boolean, "conversation rail row for visual proof")
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(marker)})`), Boolean, "native answer visible")
  await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))")
  const shot = await command("Page.captureScreenshot", { format: "png" })
  await writeFile(join(root, name), Buffer.from(shot.data, "base64"))
}

async function completed(requestId, { startedAt, id = conversationId } = {}) {
  let observedContent = false
  let observedDispatch = false
  return waitFor(
    () => bridge("liveSnapshot", [id]),
    (snapshot) => {
      const request = snapshot?.requests.find((item) => item.id === requestId)
      const transfer = snapshot?.control?.transfers.find(
        (item) => item.input.id === requestId
      )
      if (transfer?.state.kind === "failed")
        throw new Error(transfer.state.error)
      if (
        request &&
        ["failed", "uncertain", "interrupted"].includes(request.status)
      )
        throw new Error(request.error ?? request.status)
      if (snapshot?.permissions.length)
        throw new Error("Unexpected permission in a no-tools fixture")
      if (
        startedAt !== undefined &&
        !observedDispatch &&
        request?.status === "dispatching"
      ) {
        observedDispatch = true
        report.phases.push({
          phase: "provider-dispatch",
          elapsedMs: Date.now() - startedAt,
        })
      }
      if (
        startedAt !== undefined &&
        !observedContent &&
        snapshot?.blocks.some(
          (block) => block.type === "user" && block.requestId === requestId
        ) &&
        answer(snapshot, requestId).trim()
      ) {
        observedContent = true
        report.phases.push({
          phase: "first-provider-content",
          elapsedMs: Date.now() - startedAt,
        })
      }
      return request?.status === "completed"
    },
    "provider completion",
    120_000
  )
}
/** The blocks after a turn's prompt, from the live window or, once covered, from native history. */
function turnBlocks(snapshot, requestId) {
  const index = snapshot.blocks.findIndex(
    (block) => block.type === "user" && block.requestId === requestId
  )
  if (index < 0) {
    const request = snapshot.requests.find(item => item.id === requestId)
    assert.ok(request, 'Requested turn is missing')
    const entries = snapshot.base?.entries ?? []
    // Native history includes Mako's injected control instructions. Strip only
    // that known leading envelope; the user's entire prompt must still match.
    const userText = text => text.replace(/^<mako-local-control>\n[\s\S]*?\n<\/mako-local-control>\n\n/, '')
    const matches = entries.flatMap((entry, at) => entry.kind === 'user' && userText(entry.text) === request.text ? [at] : [])
    assert.equal(matches.length, 1, 'Native history must contain one exact matching prompt')
    const following = entries.slice(matches[0] + 1)
    const nextUser = following.findIndex(entry => entry.kind === 'user')
    return following.slice(0, nextUser < 0 ? undefined : nextUser)
      .filter(entry => entry.kind === 'assistant').flatMap(entry => entry.blocks)
  }
  return snapshot.blocks.slice(index + 1)
}
function answer(snapshot, requestId) {
  return turnBlocks(snapshot, requestId)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}
const stopText =
  "Write the whole numbers from 1 to 3000 in English words, one per line, with no other text. Do not use tools or modify files."
async function stopRunningTurn(nativeId) {
  const binding = (snapshot) =>
    snapshot?.control.bindings.find((item) => item.nativeId === nativeId)
  const before = binding(await bridge("liveSnapshot", [conversationId]))
  const requestId = randomUUID()
  await bridge("livePrompt", [conversationId, requestId, stopText, []])
  await waitFor(
    () => bridge("liveSnapshot", [conversationId]),
    (snapshot) => {
      const request = snapshot?.requests.find((item) => item.id === requestId)
      assert.ok(
        !request || request.status === "dispatching",
        `The long turn ended as ${request?.status} before Stop`
      )
      return Boolean(
        snapshot.blocks.some(
          (block) => block.type === "user" && block.requestId === requestId
        ) && answer(snapshot, requestId).length > 40
      )
    },
    "streamed output before Stop",
    120_000
  )
  const stoppedAt = Date.now()
  await bridge("liveCancel", [conversationId])
  const stopped = await waitFor(
    () => bridge("liveSnapshot", [conversationId]),
    (snapshot) => {
      const status = snapshot?.requests.find(
        (item) => item.id === requestId
      )?.status
      assert.ok(status !== "completed", "The long turn completed despite Stop")
      const current = binding(snapshot)
      return (
        status === "interrupted" &&
        snapshot.session.status === "ready" &&
        Boolean(current?.checkpoint) &&
        current.checkpoint !== before?.checkpoint &&
        current.coveredBlocks > (before?.coveredBlocks ?? 0)
      )
    },
    "stopped turn covered by a native checkpoint",
    120_000
  )
  report.phases.push({
    phase: "stop-running-turn",
    stopMs: Date.now() - stoppedAt,
    coveredBlocks: binding(stopped).coveredBlocks,
  })
  return requestId
}
/** The harness's own search tools run from the package; a shell `grep` would not prove them. */
async function searchWorkspace(when = "after-create") {
  const token = `SEARCH_${randomUUID().replaceAll("-", "")}`
  const file = `found-${token.slice(7, 15)}.txt`
  await mkdir(join(workspace, "nested"), { recursive: true })
  await writeFile(join(workspace, "nested", file), `${token}\n`)
  const requestId = randomUUID()
  await bridge("livePrompt", [conversationId, requestId, `Using your built-in file search tools, not a shell command, find the file in this workspace that contains the text ${token}. Reply with only that file's name. Do not modify files.`, []])
  const snapshot = await completed(requestId)
  const tools = turnBlocks(snapshot, requestId).filter((block) => block.type === "tool")
  const broken = tools.filter((block) => /ripgrep|not configured/i.test(JSON.stringify(block)) || block.status === "failed")
  assert.deepEqual(broken.map((block) => JSON.stringify(block).slice(0, 300)), [], "a search tool failed")
  assert.ok(tools.length > 0, "the search turn used no tool")
  assert.ok(answer(snapshot, requestId).includes(file), `the search found ${file}`)
  report.phases.push({ phase: "workspace-search", when, tools: tools.map((block) => block.title ?? block.name ?? block.toolKind ?? Object.keys(block).join(",")) })
}
async function checkNoFalseBanner(requestId) {
  const selector = `[data-conversation-id="${conversationId}"]`
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), Boolean, "conversation rail row after restart")
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const snapshot = await bridge("liveSnapshot", [conversationId])
  assert.equal(snapshot.requests.find((item) => item.id === requestId)?.status, "interrupted")
  const prompt = stopText.slice(0, 60)
  await waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(prompt)})`), Boolean, "stopped prompt visible after restart")
  await evaluate("document.fonts.ready.then(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 1500)))")
  const banner = await evaluate(`document.body.textContent.includes("Message interrupted")`)
  const shot = await command("Page.captureScreenshot", { format: "png" })
  await writeFile(join(root, "stopped-after-restart.png"), Buffer.from(shot.data, "base64"))
  assert.equal(banner, false, "A delivered, stopped message raised the Message interrupted banner after restart")
  report.phases.push({ phase: "no-false-interrupted-banner", passed: true })
}
async function startFromComposer(text) {
  await waitFor(
    () =>
      evaluate(
        "Boolean(document.querySelector('.composer-input:not([readonly])'))"
      ),
    Boolean,
    "workspace draft target"
  )
  const boot = await bridge("boot", [])
  const active = boot.tabs.find((tab) => tab.id === boot.activeTabId)
  assert.ok(active)
  assert.equal(
    await realpath(active.session.meta.cwd),
    await realpath(workspace)
  )
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('[data-live-conversation]'))"
    ),
    false
  )
  await evaluate("document.querySelector('.composer-input').focus()")
  await command("Input.insertText", { text })
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('.composer-input')?.value === ${JSON.stringify(text)}`
      ),
    Boolean,
    "composer input"
  )
  const point = await evaluate(
    `(() => { const button = document.querySelector('button[aria-label="Send"]'); if (!button || button.disabled) throw new Error('Send is unavailable'); const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`
  )
  const startedAt = Date.now()
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  })
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  })
  const id = await waitFor(
    () =>
      evaluate(
        "document.querySelector('[data-live-conversation]')?.getAttribute('data-live-conversation')"
      ),
    Boolean,
    "UI prompt acknowledgement"
  )
  const snapshot = await bridge("liveSnapshot", [id])
  assert.equal(snapshot.session.harness, provider)
  const request = snapshot.requests.find((item) => item.text.includes(marker))
  assert.ok(request)
  return { id, requestId: request.id, startedAt }
}

try {
  report.phases.push({
    phase: "packaged-imports",
    checked: assertPackagedImports(app),
  })
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
    stdio: "pipe",
  })
  const launchedAt = Date.now()
  const launch = await startPackage()
  report.phases.push({ phase: "packaged-launch", ...launch })
  const permissions = await bridge("computerPermissions", [])
  const metadata = JSON.parse(extractFile(join(app, "Contents/Resources/app.asar"), "package.json").toString("utf8"))
  assert.equal(permissions.persistentAcrossUpdates, metadata.makoDistribution === "signed" || metadata.makoDistribution === "local")
  report.build = metadata.makoBuild
  report.phases.push({ phase: "permission-status", ...permissions })
  console.log("Packaged renderer, preload, and read-only permission status ready in an isolated profile")
  if (terminalCheck) {
    const { checkPackagedTerminal } = await import("./packaged-terminal-checks.mjs")
    await checkPackagedTerminal({ app, bridge, waitFor, root, workspace, report, launchedAt })
    console.log("Packaged terminal daemon started from this bundle, ran a live shell, and stayed idle")
  }
  if (!rendererOnly) {
    if (process.env.MAKO_PACKAGE_QUESTION_SOURCE) {
      const {checkPackagedQuestionHistory}=await import('./packaged-question-history-checks.mjs')
      await checkPackagedQuestionHistory({bridge,command,evaluate,waitFor,root,report,source:process.env.MAKO_PACKAGE_QUESTION_SOURCE,restart:async()=>{await stopPackage();await startPackage()}})
    }
    const text = `Remember this marker for the next turn: ${marker}. Reply with just the marker. Do not use tools or modify files.`
    let requestId = randomUUID(),
      sentAt = Date.now()
    if (uiStart) {
      const started = await startFromComposer(text)
      conversationId = started.id
      requestId = started.requestId
      sentAt = started.startedAt
    } else {
      await bridge("liveStart", [
        provider,
        workspace,
        {
          conversationId,
          title: "Mako package verification",
          tuning: selectedModel ? { model: selectedModel } : undefined,
          initialRequest: { id: requestId, text, attachments: [] },
        },
      ])
    }
    const acceptedMs = Date.now() - sentAt
    if (acceptanceBudget !== null)
      assert.ok(
        acceptedMs <= acceptanceBudget,
        `Prompt acceptance took ${acceptedMs} ms, above ${acceptanceBudget} ms`
      )
    const first = await completed(requestId, { startedAt: sentAt })
    const completedMs = Date.now() - sentAt
    assert.ok(answer(first, requestId).includes(marker))
    const nativeId = first.session.nativeId
    let approvalEvidence
    if (approvalChecks) {
      const { checkPackagedApprovals } = await import('./packaged-approval-checks.mjs')
      approvalEvidence = await checkPackagedApprovals({ bridge, command, evaluate, waitFor, answer, conversationId, workspace, root, report })
    }
    if (process.env.MAKO_PACKAGE_ASYNC_QUESTIONS) {
      const { checkPackagedAsyncQuestions } = await import('./packaged-async-question-checks.mjs')
      await checkPackagedAsyncQuestions({bridge,command,evaluate,waitFor,conversationId,root,report,restart:async()=>{await stopPackage();await startPackage()}})
    }
    if (process.env.MAKO_PACKAGE_QUESTION_RETIREMENT) {
      const { checkPackagedQuestionRetirement } = await import('./packaged-question-retirement-checks.mjs')
      await checkPackagedQuestionRetirement({bridge,command,evaluate,waitFor,conversationId,root,report,restart:async()=>{await stopPackage();await startPackage()}})
    }
    if (process.env.MAKO_PACKAGE_EXTERNAL_QUESTION) {
      const {checkPackagedExternalQuestion}=await import('./packaged-external-question-checks.mjs')
      await checkPackagedExternalQuestion({app,bridge,command,evaluate,waitFor,conversationId,root,report,restart:async()=>{await stopPackage();await startPackage()}})
    }
    report.phases.push({
      phase: "provider-completion",
      submittedThrough: uiStart ? "composer" : "bridge",
      elapsedMs: completedMs,
      acceptedMs,
      model: first.session.settings?.model,
      nativeIdPresent: Boolean(nativeId),
    })
    console.log("Packaged provider completed a real no-tools turn")
    await captureConversation("provider-completed.png")
    await waitFor(
      () => bridge("liveSnapshot", [conversationId]),
      (snapshot) =>
        Boolean(
          snapshot?.control.bindings.find(
            (binding) => binding.nativeId === nativeId
          )?.checkpoint
        ),
      "native session discovery and durable checkpoint"
    )
    if (warmStart) {
      const model = first.session.settings?.model
      assert.ok(
        model,
        "The provider did not report a model for the warm-start check"
      )
      const id = randomUUID(),
        requestId = randomUUID(),
        startedAt = Date.now()
      await bridge("liveStart", [
        provider,
        workspace,
        {
          conversationId: id,
          title: "Warm startup verification",
          tuning: { model },
          initialRequest: {
            id: requestId,
            text: "Reply exactly WARM_READY. Do not use tools or modify files.",
            attachments: [],
          },
        },
      ])
      const acceptedMs = Date.now() - startedAt
      if (acceptanceBudget !== null)
        assert.ok(
          acceptedMs <= acceptanceBudget,
          `Warm prompt acceptance took ${acceptedMs} ms`
        )
      const warm = await completed(requestId, { startedAt, id })
      assert.ok(answer(warm, requestId).includes("WARM_READY"))
      report.phases.push({
        phase: "warm-explicit-model-start",
        acceptedMs,
        elapsedMs: Date.now() - startedAt,
        model,
      })
      await bridge("liveClose", [id])
    }
    if (searchCheck) await searchWorkspace()
    const stoppedId = stopCheck ? await stopRunningTurn(nativeId) : undefined
    await stopPackage()
    // The same profile must recover its journal; the second prompt does not include the marker.
    await startPackage()
    const loaded = await bridge("liveSnapshot", [conversationId])
    assert.ok(loaded)
    assert.equal(loaded.session.nativeId, nativeId)
    if (stoppedId) await checkNoFalseBanner(stoppedId)
    const nextId = randomUUID()
    await bridge("livePrompt", [
      conversationId,
      nextId,
      (stopCheck || searchCheck || approvalChecks || process.env.MAKO_PACKAGE_ASYNC_QUESTIONS === "1" || process.env.MAKO_PACKAGE_QUESTION_RETIREMENT === "1" || process.env.MAKO_PACKAGE_EXTERNAL_QUESTION === "1")
        ? "Reply only with the original PACKAGE_ marker I asked you to remember at the start of this session, before the intervening tests. Do not use tools or modify files."
        : "Reply only with the marker from my previous turn. Do not use tools or modify files.",
      [],
    ])
    const resumed = await completed(nextId)
    assert.equal(resumed.session.nativeId, nativeId)
    if (approvalEvidence) {
      for (const receipt of approvalEvidence.receipts) {
        const retained = resumed.control.approvalResponses.find(item=>item.id===receipt.id)
        assert.ok(retained && retained.digest===receipt.digest,'Installed restart lost an approval receipt')
      }
      report.phases.push({ phase: 'approval-restart', sameNativeSession: true, retainedReceipts: approvalEvidence.receipts.length })
      await approvalEvidence.checkQuestionAfterRestart?.()
    }
    assert.ok(
      answer(resumed, nextId).includes(marker),
      "Resumed provider must recall the original marker"
    )
    report.phases.push({ phase: "restart-native-resume-recall", passed: true })
    if (searchCheck) await searchWorkspace("after-resume")
    await captureConversation("native-resume.png")
    await bridge("liveClose", [conversationId])
    console.log(
      "Packaged restart retained the journal and resumed the same native session with marker recall"
    )
  }
  await soak()
  report.outcome = "passed"
} catch (error) {
  report.outcome = "failed"
  report.error = error instanceof Error ? error.message : String(error)
  const shot = await command('Page.captureScreenshot', { format: 'png' }).catch(() => null)
  if (shot) await writeFile(join(root, 'failure.png'), Buffer.from(shot.data, 'base64'))
  throw error
} finally {
  await stopPackage()
  if (terminalCheck) (await import("./packaged-terminal-checks.mjs")).stopPackagedTerminal(root)
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
  console.log(`Verification report: ${join(root, "result.json")}`)
}
