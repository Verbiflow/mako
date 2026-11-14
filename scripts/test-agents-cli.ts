/**
 * `mako agents` end to end, as an agent's shell runs it: a real host in a scratch home, an Apex conversation on a
 * stand-in for Grok's CLI that streams its turns (`scripts/fixtures/acp-stream-agent.mjs`), and the Apex's Session
 * read from the environment Mako gives its harness's process, as `MAKO_SESSION_ID`. `mako agents start` starts a
 * child from a brief file; its turn ends, its report wakes the Apex once, and `list`, `wait` and `read` answer what
 * it did. No model is asked and nothing of the person's is read or written.
 *
 *   npm run test:agents-cli
 */
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { AFTER_START } from "@mako/host/contracts/agent-tools"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { readFinReports } from "@mako/host/contracts/fin-reports"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { removeScratch } from "./lib/scratch-processes.mjs"

const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const scratch = await mkdtemp(join(tmpdir(), "mako-agents-cli-"))
const home = join(scratch, "home")
const dataRoot = join(scratch, "data")
const project = join(scratch, "project")
const standIn = join(scratch, "bin")
const sessions = join(scratch, "sessions")
const location = runtimeLocation(dataRoot)
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const ChangeSchema = z.looseObject({ kind: z.string(), text: z.string().optional() })
let host: ChildProcess | undefined

try {
  await Promise.all([mkdir(home, { recursive: true }), mkdir(project, { recursive: true }), mkdir(standIn, { recursive: true }), mkdir(location.directory, { recursive: true, mode: 0o700 })])
  await writeFile(join(standIn, "grok"), `#!/bin/sh
case " $* " in
  *" --version "*) echo "grok ${GROK_VERSIONS.tested} (agents stand-in)"; exit 0 ;;
  *" stdio "*) echo "$MAKO_SESSION_ID" >> ${quoted(sessions)}; exec ${quoted(process.execPath)} ${quoted(join(repo, "scripts/fixtures/acp-stream-agent.mjs"))} ;;
esac
echo "The agents stand-in for grok answers --version and agent stdio, not: $*" >&2
exit 2
`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    MAKO_DATA_ROOT: dataRoot,
    MAKO_WEB_SOCKET: location.socket,
    MAKO_PROFILE: "agents-cli-test",
    MAKO_TELEMETRY: "off",
    // Whatever machine runs it: the Mac's capacity is test-background-agents' to prove.
    MAKO_FIN_SLOTS: "8",
    MAKO_PROD: "1",
    PATH: [standIn, process.env.PATH].filter(Boolean).join(delimiter),
    MEASURE_STREAM_MS: "1200",
  }
  for (const key of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS", "MAKO_SESSION_ID"]) delete env[key]
  host = spawn(process.execPath, [join(repo, "packages/host/dist/mako-host.js")], { env, stdio: ["ignore", "ignore", "pipe"] })
  let errors = ""
  host.stderr?.on("data", (data: Buffer) => (errors = (errors + data.toString()).slice(-4_000)))
  for (const deadline = Date.now() + 60_000; ; ) {
    assert.ok(host.exitCode === null, `The host exited while starting: ${errors}`)
    if ((await probeRuntime(location.socket, { timeoutMs: 500 })).state === "ready") break
    assert.ok(Date.now() < deadline, `The host answered within a minute: ${errors}`)
    await new Promise((settle) => setTimeout(settle, 50))
  }
  const run = promisify(execFile)
  const mako = async (...args: string[]) => {
    const { stdout } = await run(process.execPath, [cli, "--socket", location.socket, "--json", ...args], { env, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim().split("\n").filter(Boolean).map((line) => ChangeSchema.parse(JSON.parse(line)))
  }
  const agents = async (session: string, ...args: string[]) => {
    const { stdout } = await run(process.execPath, [cli, "agents", ...args, "--socket", location.socket, "--cwd", project, "--json"], { env: { ...env, MAKO_SESSION_ID: session } })
    return JSON.parse(stdout)
  }

  const first = await mako("start", "grok", "Lead the sidebar review", "--cwd", project)
  const { conversationId: apex } = z.object({ conversationId: z.string() }).parse(first[0])
  const [session] = (await readFile(sessions, "utf8")).trim().split("\n")
  assert.ok(session, "the Apex's harness was told its Session")

  const briefFile = join(scratch, "brief.md")
  await writeFile(briefFile, "Review the sidebar's filter and say what you'd change.\n")
  const above = await run(process.execPath, [cli, "agents", "start", "grok", "--brief-file", briefFile, "--access", "full", "--socket", location.socket, "--cwd", project, "--json"], { env: { ...env, MAKO_SESSION_ID: session } }).then(() => undefined, (error: { code?: number; stdout?: string }) => error)
  assert.equal(above?.code, 1, "a child above its Apex's access is refused")
  assert.equal(JSON.parse(above?.stdout ?? "{}").refused, "access")
  const began = performance.now()
  const started = await agents(session, "start", "grok", "--brief-file", briefFile, "--title", "Review the filter")
  const receiptMs = performance.now() - began
  assert.ok(started.child && started.conversation, JSON.stringify(started))
  assert.equal(started.next, AFTER_START)
  const again = await agents(session, "start", "grok", "--brief-file", briefFile, "--title", "Review the filter", "--key", "same")
  const twice = await agents(session, "start", "grok", "--brief-file", briefFile, "--title", "Review the filter", "--key", "same")
  assert.equal(twice.child, again.child, "the same key answers the same child")
  assert.equal(twice.deduped, true)

  const waited = await agents(session, "wait", "--timeout", "12000")
  assert.ok(waited.reports?.length >= 1, `a report came within the wait: ${JSON.stringify(waited)}`)
  const listed = await agents(session, "list")
  assert.equal(listed.children.length, 2)
  const read = await agents(session, "read", started.child)
  assert.ok(read.text.length > 0, "its transcript reads back")

  // The person's switch comes through the one operation too: the host says who asked, for this and for a move.
  await invokeRuntime(location.socket, randomUUID(), "mako:live-transfer", [apex, { id: randomUUID(), provider: "grok", text: "Go on", attachments: [] }]).catch(() => undefined)
  for (const deadline = Date.now() + 10_000; !/a Thread continues on a harness .* by=person/.test(await readFile(join(dataRoot, "logs/host.log"), "utf8")); await new Promise((settle) => setTimeout(settle, 50)))
    assert.ok(Date.now() < deadline, "the person's switch reached continueOn")

  // `mako agents move` is the same host call from a shell: to where it is, it answers so; a harness that isn't here is refused.
  const here = await agents(session, "move", started.child, "grok")
  assert.equal(here.moved?.[0]?.state, "here", JSON.stringify(here))
  const nowhere = await agents(session, "move", started.child, "no-such-harness").catch((error: Error & { stdout?: string; stderr?: string }) => `${error.stdout}${error.stderr}`)
  assert.match(JSON.stringify(nowhere), /unknown-harness/)

  const names: string[] = listed.children.map((child: { name: string }) => child.name)
  for (const deadline = Date.now() + 30_000; ; ) {
    const history = await mako("history", apex)
    const digests = history.flatMap((line) => (line.kind === "user" && line.text?.startsWith(FROM_AGENTS) ? [line.text] : []))
    // The words name each report once; the same report rides after them as data, for the person's card of it.
    const read = digests.map(readFinReports)
    const heard = names.map((name) => read.map((each) => each.text).join("\n").split(`"${name}"`).length - 1)
    if (heard.every((count) => count > 0)) {
      assert.deepEqual(heard, names.map(() => 1), "each child's report reaches the Apex once")
      assert.deepEqual(names.map((name) => read.flatMap((each) => each.reports).filter((card) => card.name === name).length), names.map(() => 1), "and once as data")
      assert.ok(digests.length <= names.length, "in at most a wake a burst")
      break
    }
    assert.ok(Date.now() < deadline, `the Apex was woken with both reports: ${JSON.stringify(digests)}`)
    await new Promise((settle) => setTimeout(settle, 200))
  }
  const refused = await run(process.execPath, [cli, "agents", "start", "grok", "--brief-file", briefFile, "--socket", location.socket, "--cwd", project, "--json"], { env }).then(() => undefined, (error: { code?: number; stdout?: string }) => error)
  assert.equal(refused?.code, 1, "a caller with no Session is refused")
  assert.equal(JSON.parse(refused?.stdout ?? "{}").refused, "no-parent")
  console.log(JSON.stringify({ receiptMs: Math.round(receiptMs), children: listed.children.map((child: { name: string; state: { kind: string } }) => [child.name, child.state.kind]) }))
  console.log("PASS: mako agents started children from an Apex's shell, each report woke the Apex once, and list, wait and read answered")
} finally {
  if (host && host.exitCode === null) {
    const exited = once(host, "exit")
    host.kill("SIGTERM")
    await Promise.race([exited, new Promise((settle) => setTimeout(settle, 20_000))])
    if (host.exitCode === null) host.kill("SIGKILL")
  }
  await removeScratch(scratch)
  await rm(location.directory, { recursive: true, force: true })
}
