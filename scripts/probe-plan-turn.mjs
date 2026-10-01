// One minimal real planning turn through a harness's live driver, then its build.
// Spends real model usage. Usage:
//   npm run build:electron && node scripts/probe-plan-turn.mjs <harness> [--launch access:auto] [--start-only] [--out dir]
// Runs in the real HOME, as Mako does: sign-ins that refresh rotate their tokens, so a copy
// can sign the user out. Prints modes, plan card ids and sizes, request shapes and notices,
// never content. Native captures land in --out beside report.json.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { setTimeout as delay } from "node:timers/promises"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")

if (!process.versions.electron) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { launch: { type: "string" }, "start-only": { type: "boolean" }, out: { type: "string" } },
  })
  const harness = positionals[0]
  if (!harness) throw new Error("Name a harness: claude, codex, cursor, devin, grok or opencode")
  const root = mkdtempSync(join(tmpdir(), `probe-plan-${harness}-`))
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe-plan-turn", main: fileURLToPath(import.meta.url) }))
  const env = {
    ...process.env,
    MAKO_NATIVE_CAPTURE: harness,
    PROBE_HARNESS: harness,
    PROBE_ROOT: root,
    PROBE_OUT: resolve(values.out ?? join(tmpdir(), "probe-plan-turns", harness)),
  }
  if (values.launch) env.PROBE_LAUNCH = values.launch
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
  const { providerHost } = await import(join(repo, "dist-electron/providers/index.js"))
  const { installHostLog } = await import(join(repo, "dist-electron/host-log.js"))
  const { bindCodexApp } = await import(join(repo, "dist-electron/codex-app.js"))
  const { bindAcp } = await import(join(repo, "dist-electron/acp.js"))
  installHostLog(join(root, "host.log"))
  const driver = providerHost.liveDrivers.get(harness)
  const planning = driver.planning
  const id = randomUUID()
  const cwd = mkdtempSync(join(tmpdir(), `probe-plan-${harness}-cwd-`))
  const t0 = Date.now()
  const timeline = []
  const note = (entry) => {
    timeline.push({ at: Date.now() - t0, ...entry })
    console.error("step", JSON.stringify(entry).slice(0, 220))
  }
  const plans = new Map()
  const answered = new Set()
  let session
  let lastMode
  const emit = (event) => {
    if (event.type === "live-session") {
      session = event.session
      if (session.currentMode !== lastMode) note({ mode: (lastMode = session.currentMode), status: session.status })
    }
    if (event.type === "live-permission" && !answered.has(event.request.id)) {
      const request = event.request
      answered.add(request.id)
      const plan = request.implementsPlan
      const optionId = plan ? plan.approve : request.options?.find((o) => /allow/i.test(`${o.kind} ${o.optionId}`))?.optionId ?? request.options?.[0]?.optionId
      note({ asked: { kind: request.kind, options: request.options?.map((o) => `${o.optionId}:${o.kind}`), implementsPlan: plan ?? null, answer: optionId ?? "dismissed" } })
      const dispatch = { assertCurrent() {}, report: (result) => note({ answered: result.kind ?? "reported" }) }
      setTimeout(() => void driver.permission(id, request.id, optionId ? { kind: "choice", optionId } : { kind: "dismissed" }, dispatch)
        .catch((error) => note({ answerFailed: String(error).slice(0, 200) })), 100)
    }
    for (const update of event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []) {
      if (update.kind === "event") note({ event: { label: update.label, detail: update.detail, tone: update.tone } })
      if (update.kind !== "proposed-plan") continue
      if (!plans.has(update.id)) note({ plan: update.id })
      plans.set(update.id, { status: update.status, chars: update.text?.length ?? plans.get(update.id)?.chars })
    }
  }
  const ours = (event) => (event.session?.id ?? event.id ?? event.request?.sessionId ?? id) === id
  bindCodexApp((event) => ours(event) && emit(event))
  bindAcp((event) => ours(event) && emit(event))

  const options = {
    conversationId: id,
    emit,
    modeId: planning.via === "mode" ? planning.mode : driver.defaultMode,
    mcpSnapshot: async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
  }
  // A launch-only harness planning through a mode starts at this level beside Plan.
  if (planning.via === "mode" && driver.defaultMode) options.launchModeId = process.env.PROBE_LAUNCH ?? driver.defaultMode
  const started = await driver.start(cwd, options)
  session = started
  const report = { harness, planning: planning.via, started: { mode: started.currentMode, launchMode: started.launchMode ?? null, model: started.settings?.model ?? null } }
  if (!process.env.PROBE_START_ONLY) {
    const idle = async (label) => {
      await delay(1500)
      for (let waited = 0; !["ready", "failed", "closed"].includes(session?.status); waited += 200) {
        if (waited > 300_000) { report[`${label}Timeout`] = session?.status; return }
        await delay(200)
      }
    }
    const send = (text, settings) => driver.prompt(id, text, [], settings, {
      operationId: randomUUID(),
      attemptId: randomUUID(),
      report: (evidence) => evidence.kind === "refused" && note({ refused: String(evidence.error ?? "").slice(0, 200) }),
    })
    const planSettings = planning.via === "setting"
      ? { ...started.settings, options: { ...started.settings?.options, [planning.option]: true } }
      : started.settings
    // Harnesses that wait for approval build on it; the others build on a second message.
    const approves = planning.via === "mode" && harness !== "opencode"
    await send(`Plan creating hello.txt in the current folder containing the word hi. The plan is one step; ask me nothing.${approves ? " Once I approve the plan, create the file." : ""}`, planSettings)
    await idle("plan")
    report.afterPlan = { mode: session.currentMode, created: existsSync(join(cwd, "hello.txt")) }
    if (!approves && plans.size) {
      if (planning.via === "mode") await driver.setMode(id, driver.defaultMode)
      const buildSettings = planning.via === "setting"
        ? { ...planSettings, options: { ...planSettings.options, [planning.option]: false } }
        : session.settings
      await send("Implement the plan.", buildSettings)
      await idle("build")
    }
  } else {
    await delay(500)
  }
  report.timeline = timeline
  report.plans = Object.fromEntries(plans)
  report.final = {
    mode: session.currentMode,
    launchMode: session.launchMode ?? null,
    lastStop: session.lastStop ?? null,
    error: session.error?.replace(/[A-Za-z0-9_-]{32,}/g, "<masked>").slice(0, 400) ?? null,
    created: existsSync(join(cwd, "hello.txt")),
  }
  await driver.close(id)
  await delay(800)
  rmSync(cwd, { recursive: true, force: true })
  const captures = join(root, "native-captures")
  report.captures = existsSync(captures) ? readdirSync(captures) : []
  for (const name of report.captures) copyFileSync(join(captures, name), join(out, name))
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1))
  console.log(JSON.stringify(report, null, 1))
}
