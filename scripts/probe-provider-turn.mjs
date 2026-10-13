// One tiny real turn that leaves background work behind, through a harness's
// live driver, and the turn the harness starts on its own when that work
// settles. Spends real model usage. Usage:
//   npm run build:electron && node scripts/probe-provider-turn.mjs <grok | devin | claude> [--model id] [--start-only] [--out dir]
// Runs in the real HOME, as Mako does, with MAKO_NATIVE_CAPTURE on, so the
// wire it heard is kept beside report.json for `npm run decode -- <capture>
// --compare <store>`. Prints what each provider-started turn and marker said
// and how long it took to come, never a credential.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** What each harness is asked: one background helper whose only work is a marker reply, and a turn that ends without waiting for it. */
const PROMPTS = {
  grok: "Spawn exactly one subagent in the background (do not wait for it) whose whole task is: reply with exactly CHILD_DONE_GROK and nothing else, using no tools. Then end your turn at once, replying only: started.",
  devin: "Run exactly one subagent in the background (do not wait for it, and do not check on it) whose whole task is: run `sleep 25` in the shell, then reply with exactly CHILD_DONE_DEVIN and nothing else. Then end your turn at once, replying only: started.",
  claude: "Use the Monitor tool to watch this command: `sleep 4; echo tick-one; sleep 2; echo tick-two`. While it runs, run `sleep 9` in the shell in the foreground. Then reply with one short sentence about what the watch reported.",
}

if (!process.versions.electron) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: "string" }, "start-only": { type: "boolean" }, out: { type: "string" } },
  })
  const harness = positionals[0]
  if (!harness || !(harness in PROMPTS)) throw new Error(`Name a harness: ${Object.keys(PROMPTS).join(", ")}`)
  const root = mkdtempSync(join(tmpdir(), `mako-live-test-turn-${harness}-`))
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe-provider-turn", main: fileURLToPath(import.meta.url) }))
  const env = {
    ...process.env,
    MAKO_NATIVE_CAPTURE: harness,
    PROBE_HARNESS: harness,
    PROBE_ROOT: root,
    PROBE_OUT: resolve(values.out ?? join(tmpdir(), "probe-provider-turns", harness)),
  }
  if (values.model) env.PROBE_MODEL = values.model
  if (values["start-only"]) env.PROBE_START_ONLY = "1"
  const child = spawn(join(repo, "node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 420_000)
  const [code] = await once(child, "exit")
  clearTimeout(deadline)
  rmSync(root, { recursive: true, force: true })
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  setTimeout(() => { console.error("deadline: no result in 400s"); app.exit(3) }, 400_000)
  void probe().then(() => app.exit(0), (error) => { console.error(String(error?.stack ?? error).slice(0, 2000)); app.exit(1) })
}

async function probe() {
  const { app } = await import("electron")
  const harness = process.env.PROBE_HARNESS
  const root = process.env.PROBE_ROOT
  const out = process.env.PROBE_OUT
  mkdirSync(out, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { createHarnessHost, detachedHarnessContext } = await import(join(repo, "packages/host/dist/harnesses/harness-host.js"))
  const providerHost = createHarnessHost(detachedHarnessContext(new NativeStores(false), root))
  const { installHostLog } = await import(join(repo, "packages/host/dist/base/host-log.js"))
  installHostLog(join(root, "host.log"))
  const driver = providerHost.liveDrivers.get(harness)
  const id = randomUUID()
  const cwd = mkdtempSync(join(tmpdir(), `mako-live-test-${harness}-cwd-`))
  const t0 = Date.now()
  const timeline = []
  const note = (entry) => {
    timeline.push({ at: Date.now() - t0, ...entry })
    console.error("step", JSON.stringify(entry).slice(0, 260))
  }
  let session
  let turns = 0
  const answered = new Set()
  const emit = (event) => {
    if (event.type === "live-session") {
      if (event.session.status !== session?.status) note({ status: event.session.status, lastStop: event.session.lastStop ?? null })
      session = event.session
    }
    if (event.type === "live-permission" && !answered.has(event.request.id)) {
      answered.add(event.request.id)
      const optionId = event.request.options?.find((option) => /allow/i.test(`${option.kind} ${option.optionId}`))?.optionId ?? event.request.options?.[0]?.optionId
      note({ asked: event.request.kind, answer: optionId ?? "dismissed" })
      const dispatch = { assertCurrent() {}, report: () => {} }
      setTimeout(() => void driver.permission(id, event.request.id, optionId ? { kind: "choice", optionId } : { kind: "dismissed" }, dispatch).catch(() => {}), 100)
    }
    for (const update of event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []) {
      if (update.kind === "provider-turn") {
        turns++
        note({ providerTurn: { reason: update.reason, cause: update.cause, source: update.source ?? null, body: update.body?.slice(0, 400) ?? null, at: update.at ? update.at - t0 : null } })
      }
      if (update.kind === "event") note({ event: { label: update.label, cause: update.cause ?? null, source: update.source ?? null, body: update.body?.slice(0, 400) ?? null } })
      if (update.kind === "tool" && /agent|task|monitor/i.test(`${update.name ?? ""} ${update.title}`)) note({ tool: { name: update.name ?? null, title: update.title.slice(0, 120), status: update.status } })
    }
    if (event.type === "live-agent" || event.type === "live-agents") note({ agent: JSON.stringify(event).slice(0, 240) })
  }
  const options = {
    conversationId: id,
    emit,
    modeId: driver.defaultMode,
    mcpSnapshot: async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
    ...process.env.PROBE_MODEL && { tuning: { model: process.env.PROBE_MODEL } },
  }
  if (harness === "grok") options.launchModeId = "access:full"
  if (harness === "claude") options.modeId = "bypassPermissions"
  const started = await driver.start(cwd, options)
  session = started
  const report = { harness, cwd, started: { model: started.settings?.model ?? null, mode: started.currentMode } }
  if (!process.env.PROBE_START_ONLY) {
    await driver.prompt(id, PROMPTS[harness], [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    // Mako's own turn, then the one the harness starts when its background work settles.
    const settled = async (label, ready, limit) => {
      for (let waited = 0; !ready(); waited += 200) {
        if (waited > limit) { report[`${label}Timeout`] = session?.status; return false }
        await delay(200)
      }
      return true
    }
    await delay(1500)
    await settled("ownTurn", () => ["ready", "failed", "closed"].includes(session?.status), 180_000)
    if (harness !== "claude") {
      await settled("providerTurn", () => turns > 0, 180_000)
      await delay(1500)
      await settled("providerTurnEnd", () => ["ready", "failed", "closed"].includes(session?.status), 180_000)
    }
  }
  report.timeline = timeline
  report.final = { status: session?.status ?? null, lastStop: session?.lastStop ?? null, nativeId: session?.nativeId ?? null, nativePath: session?.nativePath ?? null,
    error: session?.error?.replace(/[A-Za-z0-9_-]{32,}/g, "<masked>").slice(0, 400) ?? null }
  await driver.close(id)
  await delay(800)
  rmSync(cwd, { recursive: true, force: true })
  const captures = join(root, "logs", "native-captures")
  report.captures = existsSync(captures) ? readdirSync(captures) : []
  for (const name of report.captures) copyFileSync(join(captures, name), join(out, name))
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1))
  console.log(JSON.stringify(report, null, 1))
}
