import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"

/**
 * The shared sync reader takes every session written before it started into the record store: it serves the rail
 * without a backfill of its own (its 128 MB heap can't hold a large first capture), and runs each pass in a process
 * of its own (`mako-syncd --backfill`), newest first, at the lowest CPU priority, which ends and gives its memory back.
 * Before, a Mac whose rail this reader served held records only for sessions written while it ran.
 */

const daemon = new URL("../dist/daemon-main.js", import.meta.url).pathname
const run = promisify(execFile)
// Short, so the reader's socket under it fits a Unix socket's path.
const home = await mkdtemp("/tmp/mako-dbf-")

/** A Codex session written `hoursAgo`, before any reader ran. */
async function rollout(hoursAgo) {
  const id = randomUUID()
  const at = new Date(Date.now() - hoursAgo * 3_600_000)
  const folder = join(home, ".codex", "sessions", ...at.toISOString().slice(0, 10).split("-"))
  await mkdir(folder, { recursive: true })
  const path = join(folder, `rollout-${at.toISOString().slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`)
  const line = (record) => JSON.stringify({ timestamp: at.toISOString(), ...record })
  await writeFile(path, [
    line({ type: "session_meta", payload: { id, cwd: home, cli_version: "0.160.0" } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Written ${hoursAgo} hours ago` }] } }),
  ].join("\n") + "\n")
  await utimes(path, at, at)
  return id
}

const held = () => {
  const db = new DatabaseSync(join(home, ".mako", "records", "records.sqlite"), { readOnly: true })
  try {
    return db.prepare("SELECT native_id AS id FROM sessions WHERE harness = 'codex'").all().map((row) => row.id)
  } finally {
    db.close()
  }
}

const env = { ...process.env, HOME: home }
for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB"]) delete env[name]
try {
  const written = [await rollout(2), await rollout(30), await rollout(24 * 9)]
  await mkdir(join(home, ".mako"), { recursive: true })

  // One pass, run as the reader runs it: every session taken, and the pass's progress kept beside the store.
  await run(process.execPath, [daemon, "--backfill"], { env, timeout: 60_000 })
  assert.deepEqual(held().sort(), [...written].sort(), "every session written before is in the record store")
  const progress = JSON.parse(await readFile(join(home, ".mako", "records", "backfill.json"), "utf8"))
  assert.equal(progress.sessions, 3)
  assert.equal(progress.done, 3)
  assert.ok(progress.endedAt, "the pass ended")

  // The reader starts the pass itself once discovery is in: a session written meanwhile is taken without anyone asking.
  const later = await rollout(1)
  const reader = spawn(process.execPath, [daemon, "--on-demand"], { env, stdio: "ignore" })
  try {
    for (const deadline = Date.now() + 30_000; !held().includes(later); await delay(200))
      assert.ok(Date.now() < deadline, "the reader's own pass took the new session")
  } finally {
    reader.kill("SIGTERM")
    await new Promise((resolve) => reader.once("exit", resolve))
  }
  console.log("PASS: the shared reader takes every session written before it into the record store, in a pass of its own")
} finally {
  await rm(home, { recursive: true, force: true })
}
