// Minimal real model turns per installed harness. Uses normal selected-account
// routing; never copies credentials or replays an uncertain prompt.
import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

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
  while (!predicate(read())) {
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
  const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: Date.now(), label: "isolated native wake acceptance" })
  try {
    for (const driver of providerHost.liveDrivers.list()) {
      if (process.env.MAKO_WAKE_HARNESS && driver.provider !== process.env.MAKO_WAKE_HARNESS) continue
      let prompts = 0
      let starts = 0
      const uncertain = process.env.MAKO_WAKE_SCENARIO === "uncertain"
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
        if (!driver.available(app.getAppPath())) throw new Error("Native runtime is not installed")
        owner = new LiveConversations({ appPath: app.getAppPath(), root: join(root, `journals-${driver.provider}`),
          driver: provider => provider === driver.provider ? adapter : undefined,
          memory, history: async () => null, emit: () => {},
          nativePath: nativePathForSession,
          checkpoint: (path, provider) => providerHost.liveDrivers.get(provider ?? driver.provider)?.checkpoint?.(path),
          resumeVerdict: binding => assessProviderResume(binding, adapter),
          providerIdleMs: 100, providerWarmLimit: 0,
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
        await until("native idle hibernation", snapshot, value => value?.session.connection === "hibernated", 30000)
        owner.submit(id, randomUUID(), "What exact wake marker did I ask you to remember? Reply only with it. Do not use any tools.")
        await until("second request terminal", snapshot, value => value?.requests[1] && !["queued", "held", "dispatching"].includes(value.requests[1].status))
        const final = snapshot()
        if (final.requests[1].status !== "completed") throw new Error(`Wake request ${final.requests[1].status}`)
        if (final.session.nativeId !== nativeId) throw new Error("Native identity changed while waking")
        const reply = final.blocks.slice(firstBlocks).filter(block => block.type === "text").map(block => block.text).join("")
        if (!reply.includes(marker)) throw new Error("The resumed assistant reply lost its remembered marker")
        if (final.requests.length !== 2 || prompts !== 2 || starts !== 2) throw new Error("Unexpected dispatch or startup count")
        results.push({ harness: driver.provider, result: "passed", durationMs: performance.now() - began, starts, prompts, nativeIdRetained: true, rememberedMarker: true, requestEvidence: final.requests.map(request => request.nativeDelivery?.evidence.kind) })
      } catch (error) {
        const current = owner?.snapshot(id)
        results.push({ harness: driver.provider, result: "failed", reason: error.message, durationMs: performance.now() - began, starts: counts.starts(), prompts: counts.prompts(), connection: current?.session.connection, status: current?.session.status, requests: current?.requests.map(request => ({ status: request.status, failure: request.failure, evidence: request.nativeDelivery?.evidence.kind })) })
      } finally {
        if (owner) {
          await owner.close(id).catch(() => {})
          await owner.stop()
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
