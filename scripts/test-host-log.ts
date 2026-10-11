import assert from "node:assert/strict"
import diagnostics_channel from "node:diagnostics_channel"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  formatHostLogLine,
  hostLog,
  hostLogKept,
  installHostLog,
  keepHostLog,
  mirrorConsole,
  openHostLog,
  scrubSecrets,
  type HostLogLine,
} from "@mako/host/base/host-log"

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

  // Lines are published; nothing keeps them, or formats them, until a log subscribes.
  assert.equal(hostLogKept(), false)
  hostLog("acp", "lost", { harness: "cursor" })
  const kept = openHostLog(join(dir, "kept.log"))
  const stopKeeping = keepHostLog(kept)
  assert.equal(hostLogKept(), true)
  const heard: HostLogLine[] = []
  const listener: diagnostics_channel.ChannelListener = (line) => heard.push(z.object({ level: z.enum(["info", "warn", "error"]), scope: z.string(), message: z.string() }).parse(line))
  diagnostics_channel.subscribe("mako:host-log", listener)
  hostLog("acp", "spawned", { harness: "cursor", pid: 1 })
  diagnostics_channel.unsubscribe("mako:host-log", listener)
  assert.deepEqual(heard.map(({ scope, message }) => `${scope} ${message}`), ["acp spawned"], "anyone in the process can watch the log by its channel's name")

  // The console is the process's to mirror, and goes back as it was.
  const originalError = console.error
  const printed: string[] = []
  console.error = (...args: unknown[]) => printed.push(String(args[0]))
  const restore = mirrorConsole()
  console.error("Provider MCP configuration cleanup failed", 7)
  restore()
  console.error("after the mirror")
  console.error = originalError
  stopKeeping()
  hostLog("acp", "after keeping stopped")
  await kept.flush()
  const mirrored = await readFile(kept.path, "utf8")
  assert.doesNotMatch(mirrored, /lost|after/)
  assert.match(mirrored, /info  acp spawned harness=cursor pid=1\n/)
  assert.match(mirrored, /error console Provider MCP configuration cleanup failed 7\n/)
  assert.deepEqual(printed, ["Provider MCP configuration cleanup failed", "after the mirror"], "a mirrored console still prints")
  assert.equal(hostLogKept(), false)

  // A process's log: opened, kept and fed by the console in one call.
  const installed = installHostLog(join(dir, "installed.log"))
  console.warn("installed warning")
  hostLog("host", "installed line")
  await installed.flush()
  const written = await readFile(installed.path, "utf8")
  assert.match(written, /warn  console installed warning\n/)
  assert.match(written, /info  host installed line\n/)
  assert.ok((await stat(installed.path)).size > 0)
} finally {
  await rm(dir, { recursive: true, force: true })
}
console.log("Host log: bounded rotating lines with scrubbed fields, a never-throwing sink, lines published for whoever keeps or watches them, and a console mirror that goes back")
