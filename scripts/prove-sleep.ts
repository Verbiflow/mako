import { randomUUID } from "node:crypto"
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { assertOwnHarnessStores, proofDataRoot } from "./lib/proof-host.ts"

/**
 * The laptop closed and opened, live: cloud Threads on each harness work for some minutes, the person closes the lid
 * and opens it again, and this reads what the Mac did. For each Thread: the events its machine made while the Mac
 * slept, how soon after waking the Mac had relayed all of them, that the turn finished, and that the Mac's copy ends
 * where the machine's does. For the sign-ins: what the wake did (the refresh locks it held, the pairs it took, how
 * long until it was in step) from the host's log, and that every sign-in is in step after. Prints no secret.
 *
 *   npx tsx scripts/prove-sleep.ts --data-root <dir> [--harness claude …] [--minutes 10] [--report <file>]
 *
 * Only on a host of its own (`--data-root`: a packaged app's scratch profile, `PackagedApp`), never this Mac's own Mako,
 * whose sidebar its Threads would join; the run checks the host's harnesses run in a home of their own.
 */
const { values } = parseArgs({
  options: {
    harness: { type: "string", multiple: true },
    minutes: { type: "string", default: "10" },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    report: { type: "string" },
    "data-root": { type: "string" },
  },
})
const HARNESSES = values.harness?.length ? values.harness : ["claude", "codex", "cursor", "opencode", "grok", "devin"]
const STEPS = Math.max(2, Math.round((Number(values.minutes) * 60) / 50))
const dataRoot = proofDataRoot(values["data-root"], "the sleep proof")
const { socket } = runtimeLocation(dataRoot)
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)
await assertOwnHarnessStores(call, dataRoot)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const clock = () => new Date().toISOString().slice(11, 19)

const DescriptorSchema = z.array(z.object({ provider: z.string(), modes: z.array(z.object({ id: z.string(), access: z.string().optional() }).loose()).default([]) }).loose())
const descriptors = DescriptorSchema.parse(await call("mako:harness-descriptors", []))
/** Nobody is there to answer while the lid is closed: the mode that asks least. */
const unattended = (harness: string) => {
  const modes = descriptors.find((descriptor) => descriptor.provider === harness)?.modes ?? []
  return (modes.find((mode) => mode.access === "full") ?? modes.find((mode) => mode.access === "auto") ?? modes.find((mode) => mode.access === "edits"))?.id
}
const SnapshotSchema = z.object({
  revision: z.number(),
  requests: z.array(z.object({ id: z.string(), status: z.string() }).loose()).default([]),
  blocks: z.array(z.object({ type: z.string() }).loose()).default([]),
}).loose()
const snapshot = async (id: string) => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
const settled = (status: string | undefined) => status !== undefined && !["queued", "dispatching", "running", "pending"].includes(status)
const replyText = (shot: z.infer<typeof SnapshotSchema>) =>
  shot.blocks.filter((block) => block.type === "text").map((block) => z.object({ text: z.string() }).loose().safeParse(block).data?.text ?? "").join(" ")

/** What this Mac relayed of each cloud conversation, as its host remembers it: the revision its windows have. */
const RememberedSchema = z.object({ conversations: z.array(z.object({ conversationId: z.string(), seq: z.number(), summary: z.object({ revision: z.number() }).loose().optional() }).loose()) })
const relayed = async () => {
  const text = await readFile(join(dataRoot, "cloud", "conversations.json"), "utf8").catch(() => '{"conversations":[]}')
  return new Map(RememberedSchema.parse(JSON.parse(text)).conversations.map((entry) => [entry.conversationId, entry.summary?.revision ?? 0]))
}

/** What `mako:live-start` reads for a cloud Thread, as the composer sends it. */
type StartOptions = {
  conversationId: string
  modeId?: string
  initialRequest: { id: string; text: string; attachments: [] }
  cloud: { repository: { url: string } }
}

type Run = { harness: string; id: string; request: string; mode?: string; before?: number; atWake?: number; caughtUpMs?: number; finished?: string; done?: boolean; endsTogether?: boolean; problem?: string }
const runs: Run[] = []
const cwd = await mkdtemp(join(tmpdir(), "mako-sleep-proof-"))
const log = join(dataRoot, "logs", "host.log")
try {
  // Awake: each Thread starts and is working before the lid closes.
  const command = `node -e "let i=0;const t=setInterval(()=>{console.log('tick '+(++i));if(i>=5)clearInterval(t)},10000)"`
  const task = `Run the shell command \`${command}\` in the repository ${STEPS} times, one after another, each in the foreground, waiting for each to finish before starting the next (each takes about 50 seconds). Don't run them in the background or at once. When all ${STEPS} have finished, reply with one short sentence that includes the word DONE.`
  await Promise.all(HARNESSES.map(async (harness) => {
    const run: Run = { harness, id: randomUUID(), request: randomUUID(), mode: unattended(harness) }
    runs.push(run)
    const options: StartOptions = {
      conversationId: run.id,
      initialRequest: { id: run.request, text: task, attachments: [] },
      cloud: { repository: { url: values.repository } },
    }
    if (run.mode) options.modeId = run.mode
    try {
      await call("mako:live-start", [harness, cwd, options])
      const deadline = Date.now() + 240_000
      while ((await snapshot(run.id)).blocks.length < 2) {
        if (Date.now() > deadline) throw new Error("no output within four minutes")
        await pause(1_000)
      }
      console.log(`${clock()} ${harness.padEnd(9)} working (mode ${run.mode ?? "its one"})`)
    } catch (error) {
      run.problem = error instanceof Error ? error.message : String(error)
      console.log(`${clock()} ${harness.padEnd(9)} didn't start: ${run.problem}`)
    }
  }))
  const before = await relayed()
  for (const run of runs) run.before = before.get(run.id)
  const logFrom = (await stat(log)).size

  console.log(`\nClose the lid now, and leave it closed at least five minutes (the Threads work about ${Math.round((STEPS * 50) / 60)}). Then open it.\n`)
  // A sleep stops this process's timers while the wall clock runs on: the first tick after the wake sees the jump.
  let last = Date.now()
  const waitUntil = Date.now() + 60 * 60_000
  let slept = 0
  for (;;) {
    await pause(1_000)
    const now = Date.now()
    if (now - last > 30_000) {
      slept = now - last
      break
    }
    last = now
    if (now > waitUntil) throw new Error("the Mac didn't sleep within an hour")
  }
  const woke = performance.now()
  console.log(`${clock()} woke after ${(slept / 60_000).toFixed(1)} minutes asleep`)

  // Each Thread: the machine's revision as soon as the cloud answers, then until this Mac has relayed it.
  await Promise.all(runs.filter((run) => !run.problem).map(async (run) => {
    for (;;) {
      try {
        run.atWake = (await snapshot(run.id)).revision
        break
      } catch {
        await pause(250)
      }
      if (performance.now() - woke > 120_000) return
    }
    while (((await relayed()).get(run.id) ?? 0) < run.atWake) {
      await pause(100)
      if (performance.now() - woke > 120_000) return
    }
    run.caughtUpMs = Math.round(performance.now() - woke)
  }))

  // The turns finish on their machines; the Mac's copy ends where each machine's does.
  await Promise.all(runs.filter((run) => !run.problem).map(async (run) => {
    const deadline = Date.now() + (STEPS * 50 + 600) * 1000
    for (;;) {
      const shot = await snapshot(run.id).catch(() => undefined)
      const status = shot?.requests.find((request) => request.id === run.request)?.status
      if (shot && settled(status)) {
        run.finished = status
        run.done = /DONE/i.test(replyText(shot))
        await pause(3_000)
        const final = (await snapshot(run.id)).revision
        run.endsTogether = (await relayed()).get(run.id) === final
        return
      }
      if (Date.now() > deadline) return
      await pause(5_000)
    }
  }))

  // The sign-ins: what the host's wake did, from its own log, and their state now.
  const handle = await open(log, "r")
  const { size } = await handle.stat()
  const buffer = Buffer.alloc(Math.max(0, size - logFrom))
  await handle.read(buffer, 0, buffer.length, logFrom)
  await handle.close()
  const lines = buffer.toString("utf8").split("\n").filter((line) => /\bcloud\b/.test(line) && /in step with Mako Cloud after waking|wasn't reached after waking|took Mako Cloud|restored|wasn't kept in step|refresh lock wasn't held|moved while Mako wrote/.test(line))
  const RowsSchema = z.object({ harnesses: z.array(z.object({ harness: z.string(), status: z.string(), rotates: z.boolean().optional(), kept: z.object({ state: z.string(), refreshedBecause: z.string().nullable().optional(), waitedFrom: z.string().nullable().optional() }).loose().optional(), problem: z.string().optional() }).loose()) }).loose()
  const signIns = RowsSchema.parse(await call("mako:cloud-sign-ins", []))

  console.log(`\n${["harness", "while asleep", "caught up", "turn", "DONE", "ends together"].map((name) => name.padEnd(14)).join(" ")}`)
  for (const run of runs) {
    const cells = run.problem
      ? [run.harness, `✗ ${run.problem.slice(0, 40)}`]
      : [
          run.harness,
          run.atWake === undefined || run.before === undefined ? "?" : `${run.atWake - run.before} events`,
          run.caughtUpMs === undefined ? "✗ not" : `${(run.caughtUpMs / 1000).toFixed(1)} s`,
          run.finished ?? "✗ unfinished",
          run.done ? "yes" : "✗ no",
          run.endsTogether ? "yes" : "✗ no",
        ]
    console.log(cells.map((cell) => cell.padEnd(14)).join(" "))
  }
  console.log("\nThe sign-ins' wake, from the host's log:")
  for (const line of lines) console.log(`  ${line.replace(/correlationId=\S+/, "").slice(0, 220)}`)
  if (!lines.length) console.log("  (nothing logged: is this host's build older than the wake's lock holding?)")
  console.log("\nThe sign-ins now:")
  for (const row of signIns.harnesses) console.log(`  ${row.harness.padEnd(9)} ${row.status.padEnd(11)} ${row.kept ? `${row.kept.state}${row.kept.refreshedBecause ? `, last refreshed: ${row.kept.refreshedBecause}` : ""}${row.kept.waitedFrom ? ` (held since ${row.kept.waitedFrom})` : ""}` : ""}${row.problem ? ` ✗ ${row.problem}` : ""}`)
  const failed = [
    ...runs.filter((run) => run.problem || run.caughtUpMs === undefined || !run.finished || !run.endsTogether).map((run) => `${run.harness}: ${run.problem ?? (run.caughtUpMs === undefined ? "not caught up" : !run.finished ? "unfinished" : "the Mac's copy ends elsewhere")}`),
    ...signIns.harnesses.filter((row) => row.status === "failed" || row.kept?.state === "needs-reconnect").map((row) => `${row.harness}'s sign-in: ${row.problem ?? row.kept?.state}`),
  ]
  if (values.report) await writeFile(values.report, `${JSON.stringify({ slept, runs, lines, signIns }, null, 2)}\n`)
  console.log(failed.length ? `\n${failed.length} problem${failed.length === 1 ? "" : "s"}:\n${failed.join("\n")}` : "\nEvery Thread caught up and finished, and every sign-in is in step.")
  process.exitCode = failed.length ? 1 : 0
} finally {
  for (const run of runs) await call("mako:live-close", [run.id]).catch(() => undefined)
  await rm(cwd, { recursive: true, force: true })
}
