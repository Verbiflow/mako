/**
 * What a program holding a pipe's name gets on Windows, where any account can list the names in use and take one no
 * server listens on (`transport/pipe.ts`, `base/pipe-handshake.ts`). The host's pipe and the terminal daemon's are
 * each taken over the moment their server is gone, the way an attacker who saw the name would, and every client of
 * them is run against the impostor: the impostor must hear the handshake's nonce and nothing else (no call, no data
 * key, no keystroke), and each client must find no host, or start a daemon of its own on a new name. Also a
 * `git.exe` planted at a project's root, which must never run. Windows only.
 *
 *   npx tsx scripts/test-windows-pipes.ts
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { connect, createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { hostCommand } from "@mako/host/base/host-command"
import { startWebHost } from "@mako/host/transport/server"
import { invokeRuntime, probeRuntime, runtimeRequest, subscribeRuntime } from "@mako/host/transport/connection"
import { drawHostPipe, publishHostPipe, runtimeIdentity, windowsRuntimeDirectory } from "@mako/host/transport/pipe"
import { runtimeLocation } from "@mako/host/transport/service"
import { TerminalDaemonClient, terminalEndpoint } from "@mako/host/terminals/client"
import { handOverSecretKey } from "../electron/secret-key-link.js"

assert.equal(process.platform, "win32", "This test is Windows' own")
const scratch = await mkdtemp(join(tmpdir(), "mako-windows-pipes-"))
const folders: string[] = []

/** A program holding `pipe`: every byte any client sends it, and an HTTP answer to anything, as a host would give. */
async function impostor(pipe: string): Promise<{ heard: () => string; close: () => Promise<void> }> {
  let heard = ""
  const server: Server = createServer((socket) => {
    socket.on("error", () => undefined)
    socket.on("data", (chunk) => {
      heard += chunk.toString("latin1")
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\n\r\n{"wanted":true}')
    })
  })
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(pipe, done)
  })
  return { heard: () => heard, close: () => new Promise((done) => server.close(() => done())) }
}

/** Only handshake greetings: `MAKO-PIPE 1 <nonce>` lines, never a request. */
const onlyGreetings = (heard: string) => heard.split("\n").filter(Boolean).every((line) => /^MAKO-PIPE 1 [0-9a-f]{32}$/.test(line))

try {
  // The host's pipe: a host on this start's name, published, then gone, its name taken.
  const dataRoot = join(scratch, "data")
  const identity = runtimeIdentity(dataRoot)
  const directory = windowsRuntimeDirectory(identity)
  folders.push(directory)
  const first = drawHostPipe(identity)
  const second = drawHostPipe(identity)
  assert.notEqual(first.pipe, second.pipe, "every start draws a name of its own")
  const host = await startWebHost(first.pipe, async () => JSON.stringify("pong"), async () => new Response(""), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, first.proof)
  publishHostPipe(directory, first)
  assert.equal(runtimeLocation(dataRoot).socket, first.pipe, "clients find the published name")
  assert.equal(await invokeRuntime(first.pipe, randomUUID(), "mako:boot", []), "pong", "a client that proves itself is answered")
  // A connection that skips the handshake is answered nothing and closed.
  const skipped = await new Promise<string>((done) => {
    let said = ""
    const socket = connect(first.pipe)
    socket.on("data", (chunk: Buffer) => (said += chunk.toString()))
    socket.on("close", () => done(said))
    socket.on("error", () => undefined)
    socket.write("GET /health HTTP/1.1\r\nhost: x\r\n\r\n")
  })
  assert.equal(skipped, "", "the host answers nothing to a connection that skips the handshake")
  host.close()
  await delay(200)

  const taken = await impostor(first.pipe)
  // Every client, against the impostor, by the name still published.
  assert.equal((await probeRuntime(first.pipe)).state, "absent", "a probe finds no host")
  await assert.rejects(invokeRuntime(first.pipe, randomUUID(), "mako:boot", []), "a call isn't made")
  await assert.rejects(runtimeRequest({ socket: first.pipe, path: "/secret-key", read: (body) => body, call: { channel: "x", body: '{"key":"DATA-KEY-MATERIAL"}' } }))
  const unsubscribe = subscribeRuntime(first.pipe, randomUUID(), () => assert.fail("no event comes from an impostor"), () => undefined)
  const handed = await handOverSecretKey(first.pipe, join(scratch, "no-key"), { available: async () => true, encrypt: async () => Buffer.from("DATA-KEY-MATERIAL"), decrypt: async () => "DATA-KEY-MATERIAL" }).catch((error: Error) => error)
  assert.ok(handed instanceof Error, `the desktop's handover fails, not ${String(handed)}`)
  await delay(500)
  unsubscribe()
  await taken.close()
  assert.ok(taken.heard().length > 0, "the clients did reach the impostor")
  assert.ok(onlyGreetings(taken.heard()), `the impostor heard only handshake nonces: ${JSON.stringify(taken.heard().slice(0, 300))}`)
  assert.doesNotMatch(taken.heard(), /DATA-KEY|POST|GET|mako:/)
  console.log("ok   an impostor on the host's published pipe hears only nonces: no call, no event stream, no data key")

  // The terminal daemon's pipe: a daemon, gone, its name taken; the client must start another on a new name.
  const stateDir = join(scratch, "terminals")
  const terminals = new TerminalDaemonClient(resolve("packages/host/dist/terminals/daemon.js"), stateDir, () => undefined, "windows-pipes")
  const session = await terminals.create({ cwd: scratch, title: "before", cols: 80, rows: 24 })
  const before = terminalEndpoint(stateDir)
  const daemon = terminals.daemonPid()
  assert.ok(daemon, "the client knows its daemon")
  await terminals.kill(session.id)
  process.kill(daemon, "SIGKILL")
  for (let tries = 0; tries < 50; tries += 1) {
    try {
      process.kill(daemon, 0)
      await delay(100)
    } catch {
      break
    }
  }
  // The name is free once the last handle to it closes, this client's own end included, a moment after the daemon died.
  let squatted: Awaited<ReturnType<typeof impostor>> | undefined
  for (let tries = 0; !squatted; tries += 1) {
    squatted = await impostor(before).catch((error: Error) => {
      if (tries >= 50) throw error
      return undefined
    })
    if (!squatted) await delay(100)
  }
  const after = await terminals.create({ cwd: scratch, title: "after", cols: 80, rows: 24 })
  await terminals.kill(after.id)
  const replaced = terminalEndpoint(stateDir)
  assert.notEqual(replaced, before, "the client started a daemon on a new name")
  assert.ok(onlyGreetings(squatted.heard()), `the impostor heard only handshake nonces: ${JSON.stringify(squatted.heard().slice(0, 300))}`)
  assert.doesNotMatch(squatted.heard(), /create|write|hello/)
  const replacement = terminals.daemonPid()
  terminals.dispose()
  await squatted.close()
  if (replacement) process.kill(replacement, "SIGKILL")
  console.log("ok   an impostor on the terminal daemon's pipe hears only nonces; a new daemon starts on a new name")

  // A git.exe at a project's root: Windows would run it for a bare `git` started there. cmd.exe stands in for it, so
  // what ran is plain: Git says what it is, cmd.exe its banner.
  const project = join(scratch, "planted")
  await mkdir(project, { recursive: true })
  await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), join(project, "git.exe"))
  await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), join(project, "git.com"))
  const { stdout } = await hostCommand("git", ["--version"], { cwd: project, timeout: 20_000 })
  assert.match(stdout, /^git version/, `Git ran, not what was planted: ${stdout.slice(0, 200)}`)
  // And Node's own search, as a child of the host started with a bare name would: the host sets
  // NoDefaultCurrentDirectoryInExePath, which libuv's search honours.
  const bare = await new Promise<string>((done) => {
    const child = spawn("git", ["--version"], { cwd: project, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.on("error", (error) => done(`error ${error.message}`))
    child.on("close", () => done(out))
  })
  console.log(`info a bare spawn of git from the planted folder, outside the host's launcher, said: ${JSON.stringify(bare.slice(0, 80))}`)
  console.log("ok   a git.exe or git.com planted at a project's root never runs: the host starts Git by its whole path")
  console.log("PASS: Windows pipes prove their servers, and no planted program runs")
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  for (const folder of folders) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
}
