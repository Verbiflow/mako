import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatHostLogLine,
  hostLog,
  hostLogPath,
  installHostLog,
  openHostLog,
  scrubSecrets,
  flushHostLog,
} from "../electron/host-log.ts"

const dir = await mkdtemp(join(tmpdir(), "mako-host-log-"))
try {
  // Fields are `key=value`, quoted when they contain whitespace, bounded, and
  // never carry a bearer token or a `token=` value even if a stderr tail did.
  const line = formatHostLogLine(
    new Date("2026-09-11T21:14:02.000Z"),
    "warn",
    "acp",
    "start failed",
    {
      harness: "grok",
      error: "grok produced no output for 20 s during session/new",
      stderr: "Authorization: Bearer sKzcq6NJOdqWVI1oHzE41OKjg4QqJkZKeIWVI78g-wE\nurl=http://127.0.0.1:62779/mcp?token=abc123def",
      code: null,
      skipped: undefined,
      pid: 70699,
      exited: false,
    }
  )
  assert.equal(
    line,
    '2026-09-11T21:14:02.000Z warn  acp start failed harness=grok error="grok produced no output for 20 s during session/new" stderr="Authorization: Bearer … url=http://127.0.0.1:62779/mcp?token=…" code=- pid=70699 exited=false\n'
  )
  assert.equal(scrubSecrets("x-api-key=abcdef Bearer short"), "x-api-key=… Bearer short")
  const long = formatHostLogLine(new Date(0), "info", "s", "m", { text: "a".repeat(2_000) })
  assert.ok(long.length < 1_400, "an oversized field is cut, not written whole")

  // Rotation: the file becomes `.1` once it would pass the cap.
  const path = join(dir, "logs", "host.log")
  const log = openHostLog(path, { maxBytes: 200, now: () => new Date("2026-09-11T00:00:00.000Z") })
  for (let index = 0; index < 6; index += 1) log.write("info", "test", `line ${index}`, { index })
  await log.flush()
  const current = await readFile(path, "utf8")
  const rotated = await readFile(`${path}.1`, "utf8")
  assert.ok(current.length <= 200 && rotated.length <= 200)
  assert.ok(rotated.includes("line 0") && current.includes("line 5"))
  assert.equal([...current.matchAll(/^2026-09-11T00:00:00.000Z info  test line \d index=\d$/gm)].length, current.trim().split("\n").length)

  // A write to an unwritable place never throws or rejects.
  const broken = openHostLog(join(dir, "logs", "host.log", "nested", "impossible.log"))
  broken.write("error", "test", "goes nowhere")
  await broken.flush()

  // The process-wide sink: console.warn and console.error are mirrored once.
  assert.equal(hostLogPath(), null)
  const installed = installHostLog(join(dir, "installed.log"))
  installHostLog(join(dir, "installed.log"))
  assert.equal(hostLogPath(), installed.path)
  const originalWarn = console.warn
  const seen: string[] = []
  console.warn = (...args: unknown[]) => seen.push(String(args[0]))
  installHostLog(join(dir, "installed.log"))
  hostLog("acp", "spawned", { harness: "cursor", pid: 1 })
  console.error("Provider MCP configuration cleanup failed", 7)
  await flushHostLog()
  const mirrored = await readFile(join(dir, "installed.log"), "utf8")
  assert.match(mirrored, /info  acp spawned harness=cursor pid=1\n/)
  assert.match(mirrored, /error console Provider MCP configuration cleanup failed 7\n/)
  assert.equal((mirrored.match(/cleanup failed/g) ?? []).length, 1, "installing twice keeps one console mirror")
  console.warn = originalWarn
  assert.deepEqual(seen, [])
  assert.ok((await stat(join(dir, "installed.log"))).size > 0)
} finally {
  await rm(dir, { recursive: true, force: true })
}
console.log("Host log: bounded rotating lines with scrubbed fields, a never-throwing sink, and a single console mirror")
