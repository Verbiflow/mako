import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { connectDaemon } from "../dist/daemon.js"
import { openProcessLog, syncdLogPath } from "../dist/process-log.js"

/**
 * The shared sync reader keeps a log of its own (`~/.mako/logs/syncd.log`): its start, each client, why it retires,
 * how it exits and its backfill pass's process. Its stdio is ignored by whoever spawns it, and once it restarted
 * every 20 to 60 s for an hour with nothing anywhere saying why.
 */

const daemon = new URL("../dist/daemon-main.js", import.meta.url).pathname
// Short, so the reader's socket under it fits a Unix socket's path.
const home = await mkdtemp("/tmp/mako-sdl-")
const env = { ...process.env, HOME: home }
for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB", "MAKO_STORE_WRITER", "MAKO_DAEMON_VERSION"]) delete env[name]

const logPath = syncdLogPath(join(home, ".mako"))
const logged = () => readFile(logPath, "utf8").catch(() => "")
async function waitFor(pattern, what, ms = 30_000) {
  for (const deadline = Date.now() + ms; ; await delay(100)) {
    const text = await logged()
    const match = pattern.exec(text)
    if (match) return match
    assert.ok(Date.now() < deadline, `${what}; the log so far:\n${text}`)
  }
}
const exited = (child) => new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))

try {
  // The writer: one line each, bounded by rotation, secrets scrubbed, and last words written synchronously along with
  // every line still queued.
  {
    const path = join(home, "unit", "unit.log")
    const log = openProcessLog(path, { maxBytes: 300, now: () => new Date("2026-10-28T21:55:00.000Z") })
    for (let index = 0; index < 8; index += 1) log.write("info", "syncd", `line ${index}`, { index })
    log.write("warn", "syncd", "client left", { error: "Authorization: Bearer sKzcq6NJOdqWVI1oHzE41OKjg4Qq url=/x?token=abc123" })
    await log.flush()
    const current = await readFile(path, "utf8")
    const rotated = await readFile(`${path}.1`, "utf8")
    assert.ok(current.length <= 300 && rotated.length <= 300, "the log and its one rotation stay within the bound")
    assert.match(current, /^2026-10-28T21:55:00.000Z warn  syncd client left error="Authorization: Bearer … url=\/x\?token=…"$/m)
    assert.doesNotMatch(current + rotated, /sKzcq6|abc123/, "no secret is written")

    const last = openProcessLog(join(home, "unit", "last.log"))
    last.write("info", "syncd", "queued")
    last.writeNow("error", "syncd", "uncaught exception", { error: "boom" })
    const now = await readFile(last.path, "utf8")
    assert.match(now, /info  syncd queued\n.*error syncd uncaught exception error=boom\n$/, "the queued line goes first, synchronously")
    await last.flush()
    assert.equal(await readFile(last.path, "utf8"), now, "and is not written twice")
  }

  await mkdir(join(home, ".mako"), { recursive: true })

  // An on-demand reader: its start, its socket, a client coming and going, its backfill pass, and the idle expiry
  // that retires it, through to its exit line.
  {
    const reader = spawn(process.execPath, [daemon, "--on-demand"], { env, stdio: "ignore" })
    const ended = exited(reader)
    await waitFor(new RegExp(`info  syncd started pid=${reader.pid} ppid=\\d+ role=on-demand node=v[\\d.]+ heapLimitMb=\\d+`), "the reader logs its start")
    const [, socket] = await waitFor(/info  syncd claiming socket=(\S+) identity=[a-f0-9]{64}/, "the reader logs its socket")
    await waitFor(/reader available/, "what it prints is kept")
    const client = await connectDaemon(socket)
    await waitFor(/info  syncd client connected clients=1/, "a client is logged")
    client.close()
    await waitFor(/info  syncd client left clients=0/, "a client leaving is logged")
    const { code } = await ended
    assert.equal(code, 0)
    const text = await logged()
    assert.match(text, /info  syncd retiring reason="no clients" clients=0 idleMs=10000/)
    assert.match(text, new RegExp(`info  syncd exited pid=${reader.pid} code=0 reason="retired: no clients"\\n`))
    const [, pass] = /info  syncd backfill pass started pid=(\d+) heapMb=768/.exec(text) ?? []
    assert.ok(pass, "the backfill pass's start is logged")
    assert.match(text, new RegExp(`info  backfill started pid=${pass} ppid=${reader.pid} role=backfill`), "the pass logs its own start")
    assert.match(text, new RegExp(`syncd backfill pass ended pid=${pass} code=(0|-) signal=(-|SIGTERM) ms=\\d+`), "and how it ended")
    assert.match(text, /info  syncd memory rssMb=\d+ heapUsedMb=\d+/)
  }

  // SIGTERM is a reason too.
  {
    const before = (await logged()).length
    const reader = spawn(process.execPath, [daemon, "--on-demand"], { env, stdio: "ignore" })
    const ended = exited(reader)
    for (const deadline = Date.now() + 30_000; !(await logged()).slice(before).includes("reader available"); await delay(100))
      assert.ok(Date.now() < deadline, "the second reader serves")
    reader.kill("SIGTERM")
    await ended
    const text = (await logged()).slice(before)
    assert.match(text, /info  syncd stopping signal=SIGTERM\n/)
    assert.match(text, new RegExp(`info  syncd exited pid=${reader.pid} code=0 reason=SIGTERM\\n`))
  }
  console.log("PASS: the shared reader logs its start, clients, backfill passes, memory and why it exits, in a bounded log with secrets scrubbed")
} finally {
  await rm(home, { recursive: true, force: true })
}
