import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostProbe, isProbe } from "@mako/host/base/host-command"
import { HostStopping } from "@mako/host/base/host-stopping"
import { processIdentityMatches, processStartedAt } from "@mako/host/base/process-liveness"
import { claudeProcessProbeFor } from "@mako/host/harnesses/claude/process-probe"
import { grokProcessProbe } from "@mako/host/harnesses/grok/process-probe"
import { childProcessReader } from "@mako/host/workspaces/watch-backend"

/**
 * The host's probes run in its probe child, never spawned on its loop. A profiled 600 s run of main under 20 Fins
 * (2026-11-12) held the loop about 13 s in synchronous spawns of probes that only read the machine: fseventsd's
 * reading 3.6 s, start times for liveness 3.0 s, the Devin probe 2.5 s with no Devin running, the Fin cost sampler's
 * `ps` 1.6 s, footprints and free memory 1.2 s, the open-files probe 0.5 s. `hostProbe` runs each in one long-lived
 * child (`HostStopping.probes`), answering as `hostCommand` does, and start times asked in one turn share one `ps`.
 *
 * `ps` and `pgrep` are counted through wrappers first on PATH, which note who ran them.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-host-probes-")))
const bin = join(root, "bin")
const calls = join(root, "calls")
mkdirSync(bin)
for (const [name, real] of [["ps", "/bin/ps"], ["pgrep", "/usr/bin/pgrep"]] as const) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $PPID $*" >> '${calls}'\nexec ${real} "$@"\n`)
  chmodSync(join(bin, name), 0o755)
}
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
const noted = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")) : [])

const stopping = new HostStopping()
stopping.probes = childProcessReader()
try {
  await stopping.run(async () => {
    assert.ok(isProbe("ps", []) && isProbe("/usr/sbin/lsof", []) && isProbe("/usr/bin/nice", ["-n", "19", "/usr/bin/footprint"]), "the probes are known")
    assert.ok(!isProbe("git", []) && !isProbe("/usr/bin/nice", ["-n", "19", "git"]), "nothing else is")
    assert.ok(isProbe("docker", ["context", "inspect", "--format", "{{.Name}}"]) && !isProbe("docker", ["run", "alpine"]) && !isProbe("docker", []), "of a program that can write, only its reading command is")

    // A probe runs in the child, and answers as hostCommand does.
    const { stdout } = await hostProbe("ps", ["-o", "pid=", "-p", String(process.pid)])
    assert.equal(Number(stdout.trim()), process.pid)
    const [first] = noted()
    assert.ok(first && first[0] === "ps" && Number(first[1]) !== process.pid, "ps ran in the probe child, not here")

    // A failing probe carries its exit code and output, as hostCommand's error does.
    await assert.rejects(hostProbe("pgrep", ["-x", "no-such-process-mako"]), { code: 1, stdout: "" }, "pgrep's exit 1 is the error's code, with what it printed")

    // Start times asked in one turn are read by one ps.
    const before = noted().length
    const pids = [process.pid, process.ppid]
    const [mine, parent] = await Promise.all(pids.map((pid) => processStartedAt(pid, AbortSignal.timeout(5_000))))
    assert.ok(Number.isFinite(mine) && Number.isFinite(parent) && mine! >= parent!, "both start times are read")
    const reads = noted().slice(before)
    assert.equal(reads.length, 1, "by one ps")
    assert.ok(reads[0]!.includes(pids.join(",")), "naming both pids")
    assert.equal(await processIdentityMatches({ pid: process.pid, startedAt: mine, signal: AbortSignal.timeout(5_000), exact: true }), true, "a live process matches its start")

    // A harness's registry of several sessions costs one process listing, however many records it holds: asked one
    // record at a time each cost its own, and a wake's ownership check ran out of time (`claudeProcessProbeFor`).
    const sleepers = Array.from({ length: 4 }, () => spawn("/bin/sleep", ["60"], { stdio: "ignore" }))
    try {
      const profile = join(root, "claude-home")
      mkdirSync(join(profile, "sessions"), { recursive: true })
      const owners = [process.pid, process.ppid, ...sleepers.map((child) => child.pid!)]
      for (const [index, pid] of owners.entries())
        writeFileSync(join(profile, "sessions", `${pid}.json`), JSON.stringify({ sessionId: `session-${index}`, pid, startedAt: pid === process.pid ? mine : pid === process.ppid ? parent : Date.now(), state: "working" }))
      const target = { nativeId: "session-0", path: join(profile, "projects", "workspace", "session-0.jsonl") }
      const listings = noted().length
      const registry = await claudeProcessProbeFor(join(root, "no-home")).probe(AbortSignal.timeout(5_000), target)
      assert.ok(registry.kind === "available" && registry.sessions.length === owners.length, `every live record is a session: ${JSON.stringify(registry)}`)
      const listed = noted().slice(listings)
      assert.equal(listed.length, 1, `${owners.length} registry records cost one process listing, not ${listed.length}`)
      assert.ok(owners.every((pid) => listed[0]!.some((word) => word.split(",").includes(String(pid)))), "naming every pid")
      // Grok's registry is one file of many sessions: the same single listing.
      const grok = join(root, "grok-home")
      mkdirSync(join(grok, "sessions", "workspace", "session-0"), { recursive: true })
      writeFileSync(join(grok, "active_sessions.json"), JSON.stringify(owners.map((pid, index) => ({ session_id: `session-${index}`, pid, opened_at: pid === process.pid ? mine : pid === process.ppid ? parent : Date.now() }))))
      const grokListings = noted().length
      const grokRegistry = await grokProcessProbe.probe(AbortSignal.timeout(5_000), { nativeId: "session-0", path: join(grok, "sessions", "workspace", "session-0", "updates.jsonl") })
      assert.ok(grokRegistry.kind === "available" && grokRegistry.sessions.length === owners.length, JSON.stringify(grokRegistry))
      assert.equal(noted().length - grokListings, 1, "Grok's registry costs one process listing too")
      // The host's own running children are answered from its record of their start: no listing for them at all.
      const spawned = new Map(sleepers.map((child) => [child.pid!, Date.now()]))
      stopping.spawnedAt = (pid) => spawned.get(pid)
      const own = noted().length
      const again = await claudeProcessProbeFor(join(root, "no-home")).probe(AbortSignal.timeout(5_000), target)
      assert.ok(again.kind === "available" && again.sessions.length === owners.length)
      const asked = noted().slice(own)
      assert.equal(asked.length, 1, "one listing for the pids that aren't the host's")
      assert.ok(sleepers.every((child) => !asked[0]!.some((word) => word.split(",").includes(String(child.pid)))), "and none of the host's own children in it")
      // Its record still decides: a registry record naming one of its pids with another start isn't that process.
      spawned.set(sleepers[0]!.pid!, Date.now() - 3_600_000)
      const stale = await claudeProcessProbeFor(join(root, "no-home")).probe(AbortSignal.timeout(5_000), target)
      assert.ok(stale.kind === "available" && stale.sessions.length === owners.length - 1, "a record that started at another time is skipped")
    } finally {
      stopping.spawnedAt = undefined
      for (const child of sleepers) child.kill("SIGKILL")
    }

    // A pid that has ended among them: the rest still read, it alone fails.
    const ended = 99_999
    const [alive, gone] = await Promise.allSettled([processStartedAt(process.pid, AbortSignal.timeout(5_000)), processStartedAt(ended, AbortSignal.timeout(5_000))])
    assert.equal(alive.status === "fulfilled" && alive.value, mine, "a live pid reads beside an ended one")
    assert.equal(gone.status, "rejected", "the ended one has no start time")

    // A probe cut by its signal stops at once.
    const controller = new AbortController()
    const slow = hostProbe("lsof", ["-nP"], { signal: controller.signal, maxBuffer: 64 * 1024 * 1024 })
    controller.abort(new Error("cut"))
    await assert.rejects(slow, /cut/, "a cut probe rejects with its reason")
  })
  console.log("host probes: run in the probe child and answer as hostCommand does, failures carry their exit and output, start times asked together are one ps that a pid gone among them doesn't spoil, and a cut probe stops")
} finally {
  await stopping.stop()
  rmSync(root, { recursive: true, force: true })
}
