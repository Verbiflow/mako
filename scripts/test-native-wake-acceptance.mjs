// Minimal real model turns per installed harness. Uses normal selected-account
// routing; never copies credentials or replays an uncertain prompt.
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { processResources, summarizeProcessResources } from "./lib/control-process-resources.mjs"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-native-wake-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-native-wake", main: fileURLToPath(import.meta.url) }))
  console.log(`Native acceptance artifacts: ${root}`)
  const env = { ...process.env, MAKO_WAKE_ROOT: root, MAKO_WAKE_REPO: resolve(".") }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { env, stdio: "inherit" })
  const [code] = await once(child, "exit")
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  void main(app).then(() => app.exit(0), error => { console.error(error.message); app.exit(1) })
}

async function until(label, read, predicate, ms = 90000) {
  const started = Date.now()
  while (!predicate(await read())) {
    if (Date.now() - started > ms) throw new Error(`Timed out: ${label}`)
    await delay(50)
  }
}

async function main(app) {
  const root = process.env.MAKO_WAKE_ROOT
  const repo = process.env.MAKO_WAKE_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { providerHost } = await import(join(repo, "dist-electron/providers/index.js"))
  const { LiveConversations } = await import(join(repo, "dist-electron/live-conversations.js"))
  const { reduceLiveUpdates } = await import(join(repo, "dist-electron/contracts/live-content.js"))
  const { assessProviderResume } = await import(join(repo, "dist-electron/provider-recovery.js"))
  const { bindCodexApp } = await import(join(repo, "dist-electron/codex-app.js"))
  const { nativePathForSession } = await import(join(repo, "dist-electron/threads.js"))
  const { SessionMemory } = await import(join(repo, "dist-electron/session-memory.js"))
  const { installHostLog } = await import(join(repo, "dist-electron/host-log.js"))
  installHostLog(join(root, "host.log"))
  const results = []
  const selected = process.env.MAKO_WAKE_HARNESSES?.split(",")
  for (const provider of selected ?? []) if (!providerHost.liveDrivers.get(provider)) throw new Error(`Unregistered acceptance harness: ${provider}`)
  const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: Date.now(), label: "isolated native wake acceptance" })
  try {
    for (const driver of providerHost.liveDrivers.list()) {
      if (process.env.MAKO_WAKE_HARNESS && driver.provider !== process.env.MAKO_WAKE_HARNESS) continue
      if (selected && !selected.includes(driver.provider)) continue
      let prompts = 0
      let starts = 0
      let nativeActivityWhileStreaming
      const uncertain = process.env.MAKO_WAKE_SCENARIO === "uncertain"
      const ownership = process.env.MAKO_WAKE_SCENARIO === "ownership"
      const closeTool = process.env.MAKO_WAKE_SCENARIO === "close-tool"
      const cancelTool = process.env.MAKO_WAKE_SCENARIO === "cancel-tool" || closeTool
      const cancellation = process.env.MAKO_WAKE_SCENARIO === "cancel" || ownership || cancelTool
      let cancelledChildEnded
      let foregroundChildAgeAtStopMs
      let foregroundChildAgeAtEndMs
      let loseEvidence = false
      let nativeStatus
      let nativeBlocks = []
      const receive = (event, forward) => {
        if (!loseEvidence) return forward(event)
        if (event.type === "live-session") nativeStatus = event.session.status
        const updates = event.type === "live-updates" ? event.updates : event.type === "live-update" ? [event.update] : []
        nativeBlocks = reduceLiveUpdates(nativeBlocks, updates)
      }
      let owner
      const resources = []
      let resourceTimer
      let sampling = Promise.resolve()
      let sampleFailure
      const sample = () => {
        sampling = sampling.then(async () => {
          if (resources.length >= 1200) throw new Error("Native resource observation exceeded its bound")
          const groups = await processResources({ acceptanceHost: process.pid })
          resources.push({ acceptanceHost: groups.acceptanceHost })
        }).catch(error => { sampleFailure ??= error })
      }
      const began = performance.now()
      const id = randomUUID()
      const counts = { starts: () => starts, prompts: () => prompts }
      const adapter = { ...driver,
        start: (cwd, options) => {
          starts++
          return driver.start(cwd, { ...options, emit: event => receive(event, event => options.emit?.(event)) })
        },
        prompt: async (id, text, attachments, tuning, dispatch) => {
          prompts++
          if (!uncertain) return driver.prompt(id, text, attachments, tuning, dispatch)
          loseEvidence = true
          await driver.prompt(id, text, attachments, tuning, { ...dispatch, report: () => {} })
          throw new Error("Acceptance injection: native delivery receipts and results lost")
        },
      }
      const cwd = join(root, `work-${driver.provider}`)
      await mkdir(cwd)
      try {
        if (process.env.MAKO_WAKE_RESOURCES === "1") { sample(); await sampling; resourceTimer = setInterval(sample, 1000) }
        if (!driver.available(app.getAppPath())) throw new Error("Native runtime is not installed")
        owner = new LiveConversations({ appPath: app.getAppPath(), root: join(root, `journals-${driver.provider}`),
          driver: provider => provider === driver.provider ? adapter : undefined,
          memory, history: async () => null, emit: () => {},
          nativePath: nativePathForSession,
          checkpoint: (path, provider) => providerHost.liveDrivers.get(provider ?? driver.provider)?.checkpoint?.(path),
          resumeVerdict: binding => assessProviderResume(binding, adapter),
          providerIdleMs: ownership || cancelTool ? 60000 : 100, providerWarmLimit: ownership || cancelTool ? 1 : 0,
          autoContinueDelayMs: 10,
          mcpSnapshot: async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
        })
        bindCodexApp(event => receive(event, event => owner.observe(event)))
        const full = driver.modes?.find(mode => mode.access === "full")
        await owner.start(driver.provider, cwd, { conversationId: id, modeId: full?.id })
        const marker = `wake-${randomUUID().slice(0, 8)}`
        if (uncertain) {
          owner.submit(id, randomUUID(), `Reply with only ${marker}. Do not use any tools.`)
          await until("native execution despite lost evidence", () => ({ nativeStatus, reply: nativeBlocks.filter(block => block.type === "text").map(block => block.text).join("") }), value => value.nativeStatus === "ready" && value.reply.trim() === marker)
          await until("host uncertainty", () => owner.snapshot(id), value => value?.requests[0]?.nativeDelivery?.evidence.kind === "uncertain")
          await delay(3000)
          const final = owner.snapshot(id)
          if (starts !== 1 || prompts !== 1 || final.requests.length !== 1) throw new Error("An uncertain native request was replayed")
          results.push({ harness: driver.provider, result: "passed", scenario: "native execution with lost host evidence", durationMs: performance.now() - began, starts, prompts, nativeReplyExact: true, hostDeliveryEvidence: final.requests[0].nativeDelivery.evidence.kind, hostRequestStatus: final.requests[0].status, observationMs: 3000 })
          await writeFile(join(root, "report.json"), JSON.stringify({ scope: "Installed native runtimes through the freshly built isolated host; not the installed Mako app", results }, null, 2))
          console.log(JSON.stringify(results.at(-1)))
          continue
        }
        owner.submit(id, randomUUID(), `Remember ${marker}. Reply with only ACK. Do not use any tools.`)
        const snapshot = () => owner.snapshot(id)
        await until("first request terminal", snapshot, value => value?.requests[0] && !["queued", "held", "dispatching"].includes(value.requests[0].status))
        if (snapshot().requests[0].status !== "completed") throw new Error(`First request ${snapshot().requests[0].status}`)
        const nativeId = snapshot().session.nativeId
        const firstBlocks = snapshot().blocks.length
        if (cancellation) {
          const childPath = join(cwd, "cancel-child.json")
          const childCode = `require("node:fs").writeFileSync(${JSON.stringify(childPath)},JSON.stringify({pid:process.pid,startedAt:Date.now()}));setTimeout(()=>console.log("DONE"),30000)`
          owner.submit(id, randomUUID(), cancelTool
            ? `Run exactly one foreground terminal command: node -e '${childCode}'. Wait for it, then reply DONE. Do not background it or run any other command.`
            : "Write a numbered list from 1 to 100000, one number per line. Begin immediately and keep writing. Do not use tools.")
          let nativeChild
          await until("native streaming before cancellation", async () => {
            if (cancelTool) nativeChild = await readFile(childPath, "utf8").then(JSON.parse, () => undefined)
            return snapshot()
          }, value => value?.requests[1] && (!["queued", "held", "dispatching"].includes(value.requests[1].status) || (value.requests[1].nativeDelivery?.evidence.kind === "accepted" && value.requests[1].status === "dispatching" && (cancelTool ? Number.isSafeInteger(nativeChild?.pid) && nativeChild.pid > 0 : value.blocks.slice(firstBlocks).some(block => block.type === "text" && block.text.length > 0)))))
          if (snapshot().requests[1].status !== "dispatching") throw new Error(`Native streaming was not observed: request ${snapshot().requests[1].status}`)
          if (process.env.MAKO_WAKE_RESOURCES === "1") {
            // Observe a real native foreground tool wait. This is not a model
            // token-stream throughput measurement or a browser-paint claim.
            await delay(15000)
            if (snapshot().requests[1].status !== "dispatching") throw new Error("Native resource workload ended before its observation window")
          }
          const control = snapshot().control
          const active = control.bindings.find(binding => binding.id === control.activeBindingId)
          // Ownership inspection is a separate acceptance observation. Waiting
          // for a process inventory before Stop lets a fast native turn finish.
          if (ownership || process.env.MAKO_WAKE_OBSERVE_ACTIVITY === "1") {
            nativeActivityWhileStreaming = await assessProviderResume(active, driver)
            if (snapshot().requests[1].status !== "dispatching") throw new Error("Native turn completed during ownership inspection; active cancellation was not tested")
            if (nativeActivityWhileStreaming.kind === "resumable") throw new Error("Admission cleared a native session while it was streaming")
          }
          if (cancelTool) foregroundChildAgeAtStopMs = Date.now() - nativeChild.startedAt
          if (closeTool) {
            await Promise.all([owner.close(id), owner.close(id)])
            if (snapshot().session.status !== "closed") throw new Error("Close did not settle the session")
          } else {
            if (!await owner.stopRequest(id, snapshot().requests[1].id)) throw new Error("Native turn completed before Stop; active cancellation was not tested")
            await until("cancelled native turn settled", snapshot, value => value?.session.status !== "running" && value.requests[1]?.status === "interrupted")
          }
          if (cancelTool) {
            const { processIdentityMatches } = await import(join(repo, "dist-electron/providers/process-liveness.js"))
            await until("cancelled native foreground child ended", () => processIdentityMatches({ pid: nativeChild.pid, startedAt: nativeChild.startedAt, signal: AbortSignal.timeout(2000) }), alive => !alive, 10000)
            foregroundChildAgeAtEndMs = Date.now() - nativeChild.startedAt
            if (foregroundChildAgeAtEndMs >= 25000) throw new Error("Foreground child may have reached its 30-second natural exit; cancellation did not prove early termination")
            cancelledChildEnded = true
          }
          if (closeTool) {
            if (prompts !== 2 || snapshot().requests.length !== 2) throw new Error("Close dispatched replacement input")
            results.push({ harness: driver.provider, result: "passed", scenario: "repeated active Close and native foreground exit; no wake or installed-app claim", durationMs: performance.now() - began, starts, prompts,
              close: { status: snapshot().session.status, foregroundChildEnded: cancelledChildEnded, foregroundChildAgeAtStopMs, foregroundChildAgeAtEndMs },
              requestEvidence: snapshot().requests.map(request => request.nativeDelivery?.evidence.kind) })
            await writeFile(join(root, "report.json"), JSON.stringify({ scope: "Installed native runtimes through the freshly built isolated host; not the installed Mako app", results }, null, 2))
            console.log(JSON.stringify(results.at(-1)))
            continue
          }
          if (ownership) {
            results.push({ harness: driver.provider, result: "passed", scenario: "native active admission refusal and targeted cancellation; no wake claim", durationMs: performance.now() - began, starts, prompts, nativeActivityWhileStreaming, requestEvidence: snapshot().requests.map(request => request.nativeDelivery?.evidence.kind), cancellation: { status: snapshot().requests[1].status, stopIssuedOnce: true } })
            await writeFile(join(root, "report.json"), JSON.stringify({ scope: "Installed native runtimes through the freshly built isolated host; not the installed Mako app", results }, null, 2))
            console.log(JSON.stringify(results.at(-1)))
            continue
          }
        }
        if (!cancelTool) await until("native idle hibernation", snapshot, value => value?.session.connection === "hibernated" || (cancellation && value?.session.connection === "disconnected"), 30000)
        const followup = cancellation ? 2 : 1
        owner.submit(id, randomUUID(), "What exact wake marker did I ask you to remember? Reply only with it. Do not use any tools.")
        await until("explicit follow-up terminal", snapshot, value => value?.requests[followup] && !["queued", "held", "dispatching"].includes(value.requests[followup].status))
        const final = snapshot()
        const context = final.session.executionContext
        if (!context || context.runtime.kind !== "reported" || context.store.kind !== "located")
          throw new Error("The live launch did not retain reported runtime and located native store context")
        if (context.identity.kind === "pending") throw new Error("Native identity remained pending after settlement")
        const binding = final.control.bindings.find(binding => binding.id === final.control.activeBindingId)
        if (JSON.stringify(binding.executionContext) !== JSON.stringify(context)) throw new Error("The saved binding lost its exact execution context")
        if (final.requests[followup].status !== "completed") throw new Error(`Wake request ${final.requests[followup].status}`)
        if (final.session.nativeId !== nativeId) throw new Error("Native identity changed while waking")
        const followupId = final.requests[followup].id
        const followupStart = final.blocks.findIndex(block => block.type === "user" && block.requestId === followupId)
        if (followupStart < 0) throw new Error("The explicit follow-up has no correlated user block")
        const reply = final.blocks.slice(followupStart + 1).filter(block => block.type === "text").map(block => block.text).join("")
        if (!reply.includes(marker)) throw new Error("The resumed assistant reply lost its remembered marker")
        if (final.requests.length !== (cancellation ? 3 : 2) || prompts !== (cancellation ? 3 : 2) || (!cancellation && starts !== 2)) throw new Error("Unexpected dispatch or startup count")
        results.push({ harness: driver.provider, result: "passed", scenario: cancelTool ? "native foreground cancellation and deliberate follow-up; no idle wake claim" : cancellation ? "native streaming cancellation, deliberate follow-up and wake" : "native wake", durationMs: performance.now() - began, starts, prompts, nativeIdRetained: true, rememberedMarker: true, nativeActivityWhileStreaming, cancellation: cancellation ? { status: final.requests[1].status, stopIssuedOnce: true, foregroundChildEnded: cancelledChildEnded, foregroundChildAgeAtStopMs, foregroundChildAgeAtEndMs } : undefined, requestEvidence: final.requests.map(request => request.nativeDelivery?.evidence.kind), executionContext: {
          transport: context.transport, runtime: context.runtime, account: context.account,
          identity: context.identity.kind === "reported" ? { kind: "reported", principalReported: true, backend: context.identity.backend, via: context.identity.via } : context.identity,
          storeLocated: true, bindingRetained: true, nativeExclusion: driver.nativeExclusion,
        } })
      } catch (error) {
        const current = owner?.snapshot(id)
        let foregroundChild
        if (cancelTool) {
          const child = await readFile(join(cwd, "cancel-child.json"), "utf8").then(JSON.parse, () => undefined)
          if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
            const state = await new Promise(resolve => execFile("ps", ["-p", String(child.pid), "-o", "pid=,ppid=,pgid=,stat=,etime="], { timeout: 1500, maxBuffer: 4096 }, (error, stdout) => resolve(error ? "unavailable" : stdout.trim())))
            foregroundChild = { state, ageMs: Date.now() - child.startedAt }
          }
        }
        results.push({ harness: driver.provider, result: "failed", reason: error.message, durationMs: performance.now() - began, starts: counts.starts(), prompts: counts.prompts(), connection: current?.session.connection, status: current?.session.status, foregroundChild, requests: current?.requests.map(request => ({ status: request.status, failure: request.failure, evidence: request.nativeDelivery?.evidence.kind })) })
      } finally {
        clearInterval(resourceTimer)
        await sampling
        if (owner) {
          await owner.close(id).catch(() => {})
          await owner.stop()
        }
        if (resources.length) {
          sample(); await sampling
          await writeFile(join(root, `resources-${driver.provider}.json`), JSON.stringify({
            scope: "Isolated native host and its process descendants; startup, model requests, 15-second foreground-tool wait and close. Sum of RSS is not unique physical RAM; no model token throughput or leak claim.",
            elapsedMs: performance.now() - began, summary: summarizeProcessResources(resources, performance.now() - began), samples: resources,
            observationFailure: sampleFailure?.message,
          }, null, 2))
          if (sampleFailure) results.push({ harness: driver.provider, result: "failed", reason: sampleFailure.message, scenario: "native resource observation" })
        }
      }
      await writeFile(join(root, "report.json"), JSON.stringify({ scope: "Installed native runtimes through the freshly built isolated host; not the installed Mako app", results }, null, 2))
      console.log(JSON.stringify(results.at(-1)))
    }
  } finally {
    await writeFile(join(root, "report.json"), JSON.stringify({ scope: "Installed native runtimes through the freshly built isolated host; not the installed Mako app", results }, null, 2))
    memory.close()
  }
  if (results.some(result => result.result !== "passed")) throw new Error("Native wake acceptance has failures; original prompts were not retried.")
}
