import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

/**
 * A sync daemon stopped while its discovery is still out starts no backfill pass. The stopping catalog awaits the
 * scan, which resolves after the stop began; the pass that resolution started before outlived the daemon, a 768 MB
 * process nobody would end. Discovery here is held until the SIGTERM (`fixtures/discovery-until-sigterm.mjs`).
 */

const daemon = new URL("../dist/daemon-main.js", import.meta.url).pathname
const holdDiscovery = new URL("./fixtures/discovery-until-sigterm.mjs", import.meta.url).pathname
// Short, so the reader's socket under it fits a Unix socket's path.
const home = await mkdtemp("/tmp/mako-dsb-")
const logPath = join(home, ".mako", "logs", "syncd.log")
const logged = () => readFile(logPath, "utf8").catch(() => "")
/** The pids of every pass the log says started, to end any this test caused. */
const passes = (text) => [...text.matchAll(/backfill pass started.*?\bpid=(\d+)/g)].map((match) => Number(match[1]))

const env = { ...process.env, HOME: home }
for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB"]) delete env[name]
let text = ""
try {
  const folder = join(home, ".codex", "sessions", "2026", "11", "18")
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, `rollout-2026-11-18T10-00-00-${randomUUID()}.jsonl`), "")
  await mkdir(join(home, ".mako"), { recursive: true })

  const reader = spawn(process.execPath, ["--import", holdDiscovery, daemon, "--on-demand"], { env, stdio: "ignore" })
  const exited = new Promise((resolve) => reader.once("exit", (code, signal) => resolve({ code, signal })))
  try {
    for (const deadline = Date.now() + 30_000; !(await logged()).includes("reader available"); await delay(50))
      assert.ok(Date.now() < deadline, "the reader serves before its discovery is in")
    assert.ok(!(await logged()).includes("discovered"), "its discovery is still out")
    reader.kill("SIGTERM")
    assert.deepEqual(await exited, { code: 0, signal: null }, "the reader stops")
  } finally {
    if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL")
  }
  text = await logged()
  assert.match(text, /stopping/, "the stop began")
  assert.match(text, /discovered \d+ sessions/, "discovery resolved while the catalog stopped")
  assert.deepEqual(passes(text), [], "no backfill pass started after the stop")
  console.log("PASS: a reader stopped while its discovery is out starts no backfill pass")
} finally {
  text ||= await logged()
  for (const pid of passes(text)) {
    try { process.kill(pid, "SIGKILL") } catch { /* already ended */ }
  }
  await rm(home, { recursive: true, force: true })
}
