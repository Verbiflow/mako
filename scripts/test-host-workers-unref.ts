import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The journal writer and the journal readers start worker threads that must not keep a process alive on their own:
// a host that is killed, or a test that forgets to stop them, still exits. A "message" listener added after `unref`
// refs the worker's port again, so each pool is started here, never stopped, and the child must end by itself.
const root = mkdtempSync(join(tmpdir(), "mako-workers-unref-"))
// Beside the scripts, so the child resolves the host's packages as they do.
const child = join(import.meta.dirname, `.workers-unref-child-${process.pid}.ts`)
try {
  writeFileSync(child, `
import { JournalWriter } from "@mako/host/conversations/journal-writer"
import { JournalReaders } from "@mako/host/conversations/journal-readers"
const writer = new JournalWriter()
writer.open(${JSON.stringify(join(root, "a.sqlite"))}, 1024 * 1024)
const readers = new JournalReaders()
void readers.read(${JSON.stringify(join(root, "missing.sqlite"))}, false).catch(() => undefined)
console.log("started")
`)
  const ran = spawnSync(process.execPath, [join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "tsconfig.scripts.json", child], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 15_000 })
  // `tsx` answers the timeout's SIGTERM by exiting itself, so a hang shows as the timeout's error, not as a signal.
  assert.equal(ran.error && "code" in ran.error ? ran.error.code : undefined, undefined, `a process with an unstopped journal writer and reader stayed up (${ran.stderr.slice(0, 400)})`)
  assert.equal(ran.status, 0, ran.stderr.slice(0, 400))
  assert.match(ran.stdout, /started/)
  console.log("host workers: an unstopped journal writer and journal reader don't keep their process alive")
} finally {
  rmSync(child, { force: true })
  rmSync(root, { recursive: true, force: true })
}
