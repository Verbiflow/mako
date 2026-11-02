import "./lib/scratch-git.mjs"
// Cursor's native routing against its own service: its model sits behind
// Cursor, so no stand-in can hear it. Three real turns through Mako's Cursor
// driver, in a scratch home holding only the CLI's Cursor key (none of the
// person's other sign-ins), each asking for one subagent through Cursor's
// `task` tool:
//
// - as an Apex, `disallowedTools: ["task"]` on `Agent.create`: no task call,
//   no subagent observed, and the model says it has no such tool;
// - the same Apex resumed (`Agent.resume`, which keeps no exclusion of its
//   own): still none;
// - as an ordinary Thread: the task call runs and its subagent is observed.
//
//   npm run test:native-routing-cursor [-- --evidence <dir>]
//
// Skipped on a Mac not signed in to Cursor. Each turn is a model request on
// the person's Cursor plan (`MAKO_LIVE_CURSOR_MODEL`, else composer-2.5).
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { RoutedThread } from "@mako/host/contracts/native-routing"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { removeScratch } from "./lib/scratch-processes.mjs"
import { readPersonSignIns, seedScratchHome, type ScratchHome } from "./scratch-harness-home.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args[evidenceAt + 1]
const MODEL = process.env.MAKO_LIVE_CURSOR_MODEL ?? "composer-2.5"
const NONE = "NO_TASK_TOOL"
const PROMPT = `Use your task tool to start one subagent that lists the files in this folder, then report what it found. If you have no task tool, don't do the work yourself: reply with exactly ${NONE}.`
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

const updates = (events: readonly LiveDriverEvent[]) => events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
const taskCalls = (events: readonly LiveDriverEvent[]) => updates(events).filter((update) => update.kind === "tool" && update.name === "task")
const children = (events: readonly LiveDriverEvent[]) => events.filter((event) => event.type === "live-agent")
const said = (events: readonly LiveDriverEvent[]) => updates(events).flatMap((update) => update.kind === "text" ? [update.text] : []).join("")

interface Turn { events: LiveDriverEvent[]; nativeId?: string; seconds: number }

async function turn(driver: ProviderLiveDriver, scratch: ScratchHome, project: string, label: string, role: RoutedThread["role"], resume?: string): Promise<Turn> {
  const { admitted } = await import("./fixtures/admitted-start.ts")
  const run: Turn = { events: [], seconds: 0 }
  const id = randomUUID()
  const began = Date.now()
  let quiet = Date.now()
  const emit = (event: LiveDriverEvent) => {
    run.events.push(event)
    quiet = Date.now()
    if (event.type === "live-session" && event.session.nativeId) run.nativeId = event.session.nativeId
    if (event.type === "live-permission") {
      const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
      if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
    }
  }
  const status = () => run.events.findLast((event) => event.type === "live-session")?.session.status
  try {
    await driver.start(project, admitted("cursor", {
      conversationId: id, emit, resume, tuning: { model: MODEL },
      mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }),
      nativeRouting: () => ({ role }),
    }, { env: scratch.env }))
    await driver.prompt(id, PROMPT, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && !(status() !== "running" && status() !== "starting" && Date.now() - quiet > 5000)) await delay(250)
    assert.ok(Date.now() < deadline, `Cursor as ${label}: the turn settled within two minutes`)
    assert.notEqual(status(), "error", `Cursor as ${label} ended in an error`)
  } finally {
    run.seconds = Math.round((Date.now() - began) / 1000)
    await Promise.resolve(driver.close(id)).catch(() => {})
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      const kept = JSON.stringify(run.events, null, 1).replaceAll(scratch.home, "<scratch>").replaceAll(project, "<project>").replace(EMAIL, "<email>").replaceAll(person, "~")
      await writeFile(join(evidence, `cursor-${label.replaceAll(" ", "-")}.json`), kept)
    }
  }
  return run
}

const { cursor: key } = readPersonSignIns()
if (!key) {
  console.log("cursor: skipped, this Mac isn't signed in to Cursor (no CLI key, no CURSOR_API_KEY)")
  process.exit(0)
}
const person = homedir()
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-native-routing-cursor-")))
const scratch = seedScratchHome(root, { cursor: key })
// From here this process runs as the scratch home, as `enterScratchHome` moves one, before any harness code reads `homedir()`.
for (const name of Object.keys(process.env)) if (!(name in scratch.env)) delete process.env[name]
Object.assign(process.env, scratch.env)
let failed = false
try {
  const project = join(root, "project")
  await mkdir(join(project, ".git"), { recursive: true })
  await writeFile(join(project, "notes.txt"), "a file to list\n")
  await writeFile(join(project, "plan.md"), "# another\n")
  const { installCursor } = await import("@mako/host/harnesses/cursor/index")
  const { sealedDrivers } = await import("./fixtures/sealed-drivers.ts")
  const driver = sealedDrivers([installCursor]).get("cursor")!
  assert.ok(driver.available(process.cwd()), "Cursor's SDK is installed")

  const apex = await turn(driver, scratch, project, "apex", "apex")
  assert.deepEqual(taskCalls(apex.events), [], "Cursor as an Apex called no task tool")
  assert.deepEqual(children(apex.events), [], "Cursor as an Apex: no subagent observed")
  assert.ok(said(apex.events).includes(NONE), "Cursor as an Apex says it has no task tool")
  assert.ok(apex.nativeId, "Cursor named its agent")
  console.log(`cursor: Apex: no task tool, no subagent (${apex.seconds} s)`)

  const resumed = await turn(driver, scratch, project, "Apex resumed", "apex", apex.nativeId)
  assert.deepEqual(taskCalls(resumed.events), [], "Cursor's Apex resumed called no task tool")
  assert.deepEqual(children(resumed.events), [], "Cursor's Apex resumed: no subagent observed")
  assert.ok(said(resumed.events).includes(NONE), "Cursor's Apex resumed says it has no task tool")
  console.log(`cursor: Apex resumed: still no task tool (${resumed.seconds} s)`)

  const thread = await turn(driver, scratch, project, "thread", "thread")
  assert.ok(taskCalls(thread.events).length > 0, "Cursor as an ordinary Thread called its task tool")
  assert.ok(children(thread.events).length > 0, "Cursor as an ordinary Thread: its subagent is observed")
  console.log(`cursor: thread: task called, subagent observed (${children(thread.events).length} roster events, ${thread.seconds} s)`)
} catch (error) {
  failed = true
  console.log(`cursor: FAILED ${error instanceof Error ? error.message : String(error)}`)
} finally {
  scratch.dispose()
  await removeScratch(root)
}
process.exit(failed ? 1 : 0)
