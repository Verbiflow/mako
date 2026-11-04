import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEGRADED_MEMORY_BYTES, SAMPLE_EVERY_MS, type FileEventsService } from "@mako/host/contracts/file-events-service"
import { clientPids, FileEventsServiceWatch, restartCommand, zoneCounts, type DaemonReading, type FileEventsServiceDeps, type PrivilegedOutcome } from "@mako/host/workspaces/file-events-service"
import type { FileHistory } from "@mako/host/workspaces/watch-backend"

/*
 * The read of fseventsd's health and its restart, against fakes: a memory
 * reader standing in for `ps`, a clock, beats as the watcher child sends
 * them, and a privileged step that plays root's part without one. Nothing
 * here signals or restarts a real daemon.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-file-events-")))
const MB = 1024 ** 2
const GB = 1024 ** 3

interface World {
  service: FileEventsServiceWatch
  daemon: { pid: number; residentBytes: number }
  clock: { now: number }
  emitted: FileEventsService[]
  lines: { message: string; fields: Record<string, string | number | boolean> }[]
  recovered: number
  asked: string[]
}

function world(overrides: Partial<FileEventsServiceDeps> = {}, name = String(Math.random()).slice(2)): World {
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  const daemon = { pid: 338, residentBytes: 9 * MB }
  const clock = { now: Date.parse("2026-11-03T12:00:00Z") }
  const made: World = { daemon, clock, emitted: [], lines: [], recovered: 0, asked: [], service: undefined! }
  made.service = new FileEventsServiceWatch({
    mac: true,
    readDaemon: async (): Promise<DaemonReading> => ({ ...daemon }),
    privileged: async (command) => {
      made.asked.push(command)
      return { kind: "cancelled" }
    },
    probe: async () => [12, 14, 11, 13, 12],
    recover: () => {
      made.recovered += 1
    },
    activity: () => ({ watched: 3, streams: 4, childStarts: 1, historyReads: 5, turnsRunning: 1 }),
    emit: (service) => made.emitted.push(service),
    log: (message, fields) => made.lines.push({ message, fields }),
    historyFile: join(folder, "fseventsd.jsonl"),
    evidenceRoot: join(folder, "crashes"),
    evidenceTemporary: join(folder, "root-made."),
    uid: process.getuid?.() ?? 0,
    now: () => clock.now,
    ...overrides,
  })
  return made
}

/** Beats every 10 s, as the canary sends them. */
function beats(made: World, lags: number[]): void {
  for (const lag of lags) {
    made.clock.now += 10_000
    made.service.beat(lag)
  }
}

try {
  // A healthy Mac: beats in tens of milliseconds, a few megabytes. Nothing is said.
  const healthy = world()
  await healthy.service.tick()
  beats(healthy, [52, 48, 61, 55, 50, 47])
  assert.equal(healthy.service.snapshot().state, "healthy")
  assert.equal(healthy.service.snapshot().lagMs, 51, "the median of the last six beats")
  assert.equal(healthy.service.snapshot().residentBytes, 9 * MB, "and the daemon's memory, read without root")
  assert.equal(healthy.emitted.filter((service) => service.state === "degraded").length, 0)
  // One late beat among healthy ones is a busy moment, not a degraded daemon.
  beats(healthy, [3_000])
  assert.equal(healthy.service.snapshot().state, "healthy", "the median holds through one slow beat")
  assert.equal(healthy.service.snapshot().slowestMs, 3_000)

  // Degraded delivery, as seen: the median beat 2.6 s late. Said within about two minutes, with the numbers.
  const late = world()
  await late.service.tick()
  const lateFrom = late.clock.now
  beats(late, [2_400, 2_700, 2_600, 2_550])
  const lateSaid = late.emitted.find((service) => service.state === "degraded")
  assert.ok(lateSaid, "degraded once four beats' median is past 250 ms")
  assert.ok(late.clock.now - lateFrom <= 120_000, `within two minutes (${late.clock.now - lateFrom} ms)`)
  assert.deepEqual(lateSaid.degraded && { lag: lateSaid.degraded.lag, memory: lateSaid.degraded.memory }, { lag: true, memory: false })
  assert.equal(lateSaid.lagMs, 2_575)
  assert.ok(late.lines.some((line) => line.message === "fseventsd is degraded" && line.fields.lagMs === 2_575), "and logged")
  // Past 250 ms, well short of the 5 s that makes watches poll.
  const mild = world()
  await mild.service.tick()
  beats(mild, [300, 320, 310, 290])
  assert.equal(mild.service.snapshot().state, "degraded", "300 ms at the median is degraded")

  // Degraded memory: two readings a minute apart over 1 GB, as `ps` reads it.
  const swollen = world()
  swollen.daemon.residentBytes = Math.round(10.5 * GB)
  await swollen.service.tick()
  assert.equal(swollen.service.snapshot().state, "healthy", "one reading is not yet sustained")
  swollen.clock.now += 60_000
  await swollen.service.tick()
  const swollenNow = swollen.service.snapshot()
  assert.equal(swollenNow.state, "degraded")
  assert.deepEqual(swollenNow.degraded && { lag: swollenNow.degraded.lag, memory: swollenNow.degraded.memory }, { lag: false, memory: true })
  assert.ok(DEGRADED_MEMORY_BYTES < swollen.daemon.residentBytes)
  // Pid checks for history reads in between don't count as minute readings.
  const checked = world()
  checked.daemon.residentBytes = 2 * GB
  await checked.service.tick()
  checked.clock.now += 2_000
  await checked.service.restartedSince(0)
  assert.equal(checked.service.snapshot().state, "healthy", "a pid check isn't a second reading")

  // A canary that goes unheard is degraded too.
  const silent = world()
  await silent.service.tick()
  silent.service.delivered(false)
  silent.clock.now += 45_000
  assert.equal(silent.service.snapshot().state, "degraded")
  assert.equal(silent.service.snapshot().silentMs, 45_000)
  silent.service.delivered(true)
  assert.equal(silent.service.snapshot().state, "healthy")

  // The rolling history: a sample every 15 minutes with what Mako was doing, kept across hosts.
  const sampled = world({}, "sampled")
  await sampled.service.tick()
  for (let minute = 1; minute <= 45; minute++) {
    sampled.clock.now += 60_000
    if (minute === 20) sampled.service.woke()
    await sampled.service.tick()
  }
  const kept = sampled.service.snapshot().history.filter((sample) => !sample.why)
  assert.equal(kept.length, 4, "one at the start and one every 15 minutes")
  assert.equal(kept[1]!.at - kept[0]!.at, SAMPLE_EVERY_MS)
  const first = sampled.service.snapshot().history[0]!
  assert.equal(first.why, "state", "the first reading is a change of state, sampled at once")
  assert.deepEqual(first.context, { watched: 3, streams: 4, childStarts: 1, historyReads: 5, turnsRunning: 1, wakes: 0 })
  assert.equal(kept[2]!.context?.wakes, 1, "a wake lands in the sample after it")
  assert.equal(kept[1]!.context?.historyReads, 0, "counts are since the sample before")
  const file = join(root, "sampled", "fseventsd.jsonl")
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, sampled.service.snapshot().history.length)

  // fseventsd started over while no host ran: the next host finds it from the file and the pid, and starts every watch over.
  const next = world({ historyFile: file }, "sampled-next")
  next.clock.now = sampled.clock.now + 30 * 60_000
  next.daemon.pid = 19_513
  const before = next.clock.now - 1
  await next.service.tick()
  assert.equal(next.recovered, 1, "every watch starts over with the new daemon")
  assert.equal(await next.service.restartedSince(before), true, "a mark from before it reads lost")
  assert.equal(await next.service.restartedSince(next.clock.now), false, "one after doesn't")
  assert.ok(next.lines.some((line) => line.message === "fseventsd started over" && line.fields.was === 338))
  assert.deepEqual(next.service.snapshot().history.slice(sampled.service.snapshot().history.length).map((sample) => sample.why), ["restarted", "state", undefined], "the day's samples carried over, then the restart, this host's first state and its first sample")

  // Someone else restarts it (`sudo killall fseventsd` in a terminal): seen at the next look, from a history read too.
  const outside = world()
  await outside.service.tick()
  const marked = outside.clock.now
  outside.clock.now += 5_000
  outside.daemon.pid = 4_242
  assert.equal(await outside.service.restartedSince(marked), true)
  assert.equal(outside.recovered, 1)

  // The restart, cancelled at the password dialog: nothing else happens.
  const cancelled = world()
  await cancelled.service.tick()
  beats(cancelled, [2_600, 2_600, 2_600, 2_600])
  const cancelledOutcome = await cancelled.service.restart()
  assert.equal(cancelled.asked.length, 1, "the password is asked once")
  assert.equal(cancelledOutcome.restart?.outcome, "cancelled")
  assert.equal(cancelledOutcome.restarting, undefined)
  assert.equal(cancelledOutcome.state, "degraded", "still degraded, still offered")
  assert.equal(cancelled.recovered, 0)
  assert.deepEqual(cancelled.emitted.map((service) => service.restarting).filter(Boolean), ["restarting"])

  // The restart, through: evidence first in the one privileged step, saved in diagnostics; every watch starts over; before and after.
  const sample = "    8079 Thread_4637: com.apple.fseventsd.notify\n    12 Thread_9: com.apple.fseventsd.client.46417\n    3 Thread_10: com.apple.fseventsd.client.46417\n    2 Thread_11: com.apple.fseventsd.client.645\n"
  const vmmap = [
    "MALLOC ZONE                            SIZE       SIZE       SIZE       SIZE      COUNT  ALLOCATED  FRAG SIZE  % FRAG   COUNT",
    "===========                         =======  =========  =========  =========  =========  =========  =========  ======  ======",
    "DefaultMallocZone_0x102e80000         18.3G       3.5G       3.5G      13.9G   89967604      18.1G         0K      0%  296971",
    "PathStringZone_0x102f48000             6.1G       5.5G       5.5G     634.0M   34892270       6.1G      21.1M      1%  293670",
  ].join("\n")
  const marks: string[] = []
  const history: FileHistory = {
    mark: async () => {
      marks.push("mark")
      return { id: "100", at: String(BigInt(Date.now()) * 1_000_000n) }
    },
    since: async (_mark, roots) => ({ paths: roots.map((folder) => join(folder, "before")), lost: [...roots], ignored: [] }),
  }
  let restarted!: World
  restarted = world({
    history: () => history,
    privileged: async (command, prompt): Promise<PrivilegedOutcome> => {
      restarted.asked.push(command)
      assert.match(prompt, /restart macOS's file-change service \(fseventsd\)/)
      // Root's part, as the command says it: a folder of its own, the evidence, then the restart.
      const made = mkdtempSync(join(root, "restarted", "root-made."))
      writeFileSync(join(made, "sample.txt"), sample)
      writeFileSync(join(made, "vmmap.txt"), vmmap)
      writeFileSync(join(made, "log.txt"), "2026-11-03 fseventsd: log lines\n")
      writeFileSync(join(made, "ps.txt"), "  PID  %CPU    RSS\n  338 146.4 10539216\n")
      restarted.daemon.pid = 19_513
      restarted.daemon.residentBytes = Math.round(8.2 * MB)
      return { kind: "done", stdout: `${made}\n` }
    },
  }, "restarted")
  restarted.daemon.residentBytes = Math.round(10.5 * GB)
  await restarted.service.tick()
  restarted.clock.now += 60_000
  await restarted.service.tick()
  beats(restarted, [2_600, 2_500, 2_700, 2_600, 4_200, 2_600])
  assert.equal(restarted.service.snapshot().state, "degraded")
  const outcome = await restarted.service.restart()
  assert.equal(restarted.asked.length, 1, "the password is asked once for all of it")
  const command = restarted.asked[0]!
  const order = ["/usr/bin/sample", "/usr/bin/vmmap --summary", "/usr/bin/log show --last 2h --predicate 'process == \"fseventsd\"' --info", "/usr/bin/killall fseventsd", `/usr/sbin/chown -R ${process.getuid?.() ?? 0} `]
  const at = order.map((part) => command.indexOf(part))
  assert.ok(at.every((index) => index >= 0), `every step is in the command:\n${command}`)
  assert.deepEqual([...at].sort((a, b) => a - b), at, "evidence before the restart, the folder handed over after")
  assert.equal(outcome.restart?.outcome, "restarted")
  assert.deepEqual(outcome.restart?.before, { lagMs: 2_600, residentBytes: Math.round(10.5 * GB) })
  assert.deepEqual(outcome.restart?.after, { lagMs: 12, residentBytes: Math.round(8.2 * MB) }, "delivery measured again after, and the new daemon's memory")
  assert.equal(outcome.state, "healthy", "the notice goes once the new daemon delivers")
  assert.equal(outcome.restarting, undefined)
  assert.equal(outcome.pid, 19_513)
  assert.equal(restarted.recovered, 1, "every watch and history reader starts over once")
  assert.equal(outcome.restart?.historyKept, true, "a change written just before was read across it")
  assert.deepEqual([...new Set(restarted.emitted.map((service) => service.restarting).filter(Boolean))], ["restarting", "measuring"], "each step said as it goes")
  assert.ok(await restarted.service.restartedSince(restarted.clock.now - 1), "a history read from before it is reported lost")
  const evidence = outcome.restart?.evidence
  assert.ok(evidence && evidence.startsWith(join(root, "restarted", "crashes", "fseventsd-")), "saved in Mako's diagnostics")
  assert.deepEqual(readdirSync(evidence).sort(), ["clients.txt", "log.txt", "ps.txt", "sample.txt", "summary.json", "vmmap.txt"])
  assert.match(readFileSync(join(evidence, "clients.txt"), "utf8"), /^46417\t.*\n645\t/, "who subscribed, from the sample's client threads, each once")
  // SAFETY: the service wrote summary.json just above, in this test's own folder, with these fields.
  const summary = JSON.parse(readFileSync(join(evidence, "summary.json"), "utf8")) as { before: unknown; after: unknown; samples: unknown[] }
  assert.deepEqual(summary.after, { lagMs: 12, residentBytes: Math.round(8.2 * MB) })
  assert.ok(summary.samples.length >= 2, "with the day's samples")
  assert.equal(readdirSync(join(root, "restarted")).some((name) => name.startsWith("root-made.")), false, "root's folder is gone once copied")
  assert.ok(restarted.lines.some((line) => line.message === "fseventsd restarted" && line.fields.beforeLagMs === 2_600 && line.fields.afterLagMs === 12))

  // A folder the privileged step didn't make is never read: the restart stands, the evidence isn't taken.
  let spoofed!: World
  spoofed = world({
    privileged: async (command) => {
      spoofed.asked.push(command)
      spoofed.daemon.pid = 777
      return { kind: "done", stdout: "/etc\n" }
    },
  })
  await spoofed.service.tick()
  const spoofedOutcome = await spoofed.service.restart()
  assert.equal(spoofedOutcome.restart?.outcome, "restarted")
  assert.equal(spoofedOutcome.restart?.evidence, undefined)
  assert.ok(spoofed.lines.some((line) => line.message === "fseventsd evidence not saved"))

  // A failure says why; off macOS nothing is read or offered.
  const failing = world({ privileged: async () => ({ kind: "failed", message: "The administrator user name or password was incorrect." }) })
  await failing.service.tick()
  assert.equal((await failing.service.restart()).restart?.message, "The administrator user name or password was incorrect.")
  const linux = world({ mac: false })
  await linux.service.tick()
  linux.service.beat(5_000)
  assert.equal(linux.service.snapshot().state, "unknown")
  await assert.rejects(linux.service.restart(), /macOS's/)

  // The command and the readers of its output.
  assert.throws(() => restartCommand(-1))
  assert.throws(() => restartCommand(501, "/tmp/$(reboot)"))
  assert.deepEqual(zoneCounts(vmmap), { DefaultMallocZone: 89_967_604, PathStringZone: 34_892_270 })
  assert.deepEqual(clientPids(sample), [46_417, 645])
  assert.equal(existsSync(join(root, "restarted", "fseventsd.jsonl")), true)
  console.log("file events service: healthy says nothing; a median beat past 250 ms or two memory readings past 1 GB is degraded within two minutes, with the numbers; a silence too; samples every 15 minutes with what Mako did, kept across hosts; a restart by anyone starts every watch over and marks earlier history lost; the restart asks once, captures the evidence before the restart, saves it in diagnostics with who subscribed, and says before and after; a cancel or failure changes nothing")
} finally {
  rmSync(root, { recursive: true, force: true })
}
