/**
 * The headless client end to end, as a person or a script drives it from a terminal: `mako` against a real host in
 * a scratch home, with a stand-in for Grok's CLI that streams its turns (`scripts/fixtures/acp-stream-agent.mjs`), so
 * no model is asked and nothing of the person's is read or written. A conversation is started and its turn streamed
 * to its end, a second message sent, a running turn stopped, and the conversation read back, every step only through
 * the host's own calls and events.
 *
 *   npx tsx scripts/test-mako-client.ts
 */
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { promisify } from "node:util"
import { probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"
import { z } from "zod"

const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const scratch = await mkdtemp(join(tmpdir(), "mako-client-"))
const home = join(scratch, "home")
const dataRoot = join(scratch, "data")
const project = join(scratch, "project")
const standIn = join(scratch, "bin")
const location = runtimeLocation(dataRoot)
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const ChangeSchema = z.looseObject({ kind: z.string() })
let host: ChildProcess | undefined

try {
  await Promise.all([mkdir(home, { recursive: true }), mkdir(project, { recursive: true }), mkdir(standIn, { recursive: true }), mkdir(location.directory, { recursive: true, mode: 0o700 })])
  await writeFile(join(standIn, "grok"), `#!/bin/sh
case " $* " in
  *" --version "*) echo "grok ${GROK_VERSIONS.tested} (client stand-in)"; exit 0 ;;
  *" stdio "*) exec ${quoted(process.execPath)} ${quoted(join(repo, "scripts/fixtures/acp-stream-agent.mjs"))} ;;
esac
echo "The client stand-in for grok answers --version and agent stdio, not: $*" >&2
exit 2
`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    MAKO_DATA_ROOT: dataRoot,
    MAKO_WEB_SOCKET: location.socket,
    MAKO_PROFILE: "client-test",
    MAKO_CURSOR_SDK_ROOT: join(scratch, "cursor"),
    MAKO_TELEMETRY: "off",
    MAKO_PROD: "1",
    PATH: [standIn, process.env.PATH].filter(Boolean).join(delimiter),
    // A turn of the stand-in: two and a half seconds of words, a thought, and a command with its output at two.
    MEASURE_STREAM_MS: "2500",
  }
  for (const key of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS"]) delete env[key]
  host = spawn(process.execPath, [join(repo, "packages/host/dist/mako-host.js")], { env, stdio: ["ignore", "ignore", "pipe"] })
  let errors = ""
  host.stderr?.on("data", (data: Buffer) => (errors = (errors + data.toString()).slice(-4_000)))
  for (const deadline = Date.now() + 60_000; ; ) {
    assert.ok(host.exitCode === null, `The host exited while starting: ${errors}`)
    if ((await probeRuntime(location.socket, { timeoutMs: 500 })).state === "ready") break
    assert.ok(Date.now() < deadline, `The host answered within a minute: ${errors}`)
    await new Promise((settle) => setTimeout(settle, 50))
  }

  const mako = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "--socket", location.socket, "--json", ...args], { env, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim().split("\n").filter(Boolean).map((line) => ChangeSchema.parse(JSON.parse(line)))
  }
  const text = (lines: Array<z.infer<typeof ChangeSchema>>) => lines.flatMap((line) => (line.kind === "text" ? [z.string().parse(line.text)] : [])).join("")

  // A conversation started with its first message, its turn streamed to the end.
  const began = performance.now()
  const first = await mako("start", "grok", "Measure the host", "--cwd", project)
  const firstMs = performance.now() - began
  const started = z.object({ kind: z.literal("started"), conversationId: z.string(), requestId: z.string() }).parse(first[0])
  assert.match(text(first), /the host reads each update/, "its words, as they streamed")
  assert.ok(first.some((line) => line.kind === "tool"), "its command, as a tool line")
  assert.deepEqual(first.at(-1), { kind: "settled", requestId: started.requestId, status: "completed" })
  const conversation = started.conversationId

  // A second message, its turn to the end too.
  const second = await mako("send", conversation, "Again")
  assert.equal(second.at(-1)?.status, "completed")
  assert.match(text(second), /the host reads each update/)

  // A turn stopped while it runs: sent without waiting, then stopped, and its request isn't completed.
  const detached = await mako("send", conversation, "Once more", "--detach")
  const { requestId } = z.object({ kind: z.literal("sent"), requestId: z.string() }).parse(detached[0])
  await new Promise((settle) => setTimeout(settle, 400))
  await mako("stop", conversation)
  const history = await mako("history", conversation)
  assert.deepEqual(history.filter((line) => line.kind === "user").length, 3, "each message, read back in order")
  assert.ok(text(history).length > text(first).length, "the turns' words, read back")
  const statuses = new Map(history.flatMap((line) => (line.kind === "request" ? [[z.string().parse(line.id), z.string().parse(line.status)] as const] : [])))
  assert.deepEqual([statuses.get(started.requestId), statuses.get(requestId)].map((status) => status === "completed"), [true, false], `the stopped turn didn't complete: ${statuses.get(requestId)}`)

  console.log(`PASS: the headless client started a conversation (first turn ${Math.round(firstMs)} ms end to end), sent to it, stopped it and read it back, through a real host's own calls and events`)
} finally {
  if (host && host.exitCode === null) {
    const exited = once(host, "exit")
    host.kill("SIGTERM")
    await Promise.race([exited, new Promise((settle) => setTimeout(settle, 20_000))])
    if (host.exitCode === null) host.kill("SIGKILL")
  }
  await rm(scratch, { recursive: true, force: true })
  await rm(location.directory, { recursive: true, force: true })
}
