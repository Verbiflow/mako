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
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { connectDaemon, onDemandCatalogPaths } from "@mako/sessions"
import { claimDaemon, DaemonAlreadyServing } from "../packages/sessions/src/daemon.ts"
import { drawFamilyPipe, familyFile, isPipeFamily, publishedFamilyPipe, publishFamilyPipe, retractFamilyPipe } from "@mako/sessions/private-pipe"
import { probeLock, takeLock } from "../packages/sessions/src/record-locks.ts"
import { resolveExecutable } from "@mako/host/base/executable"
import { windowsHelperLines } from "@mako/host/base/windows-helper"
import { identityOf, parseVerdict } from "@mako/host/base/executable-trust"
import { terminalShell } from "@mako/host/terminals/shell"
import { connectBrokeredDriver, DriverBroker, DriverNotDispatchedError } from "@mako/control-runtime/host"

const run = promisify(execFile)

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
  // The name is free once the last handle to it closes (a client's end, or the helper narrowing its DACL).
  for (let tries = 0; ; tries += 1) {
    const listened = await new Promise<Error | undefined>((done) => {
      server.once("error", done)
      server.listen(pipe, () => done(undefined))
    })
    if (!listened) break
    if (tries >= 50) throw listened
    await delay(100)
  }
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

  // The sessions daemon's pipe and a catalog reader's: a family whose server publishes a fresh pipe each start. An
  // impostor holding the published name hears only nonces, and the client finds no daemon.
  const family = "\\\\.\\pipe\\mako-syncd-test-" + randomUUID().slice(0, 8)
  assert.ok(isPipeFamily(family) && isPipeFamily(onDemandCatalogPaths("a".repeat(64)).socket), "the sessions daemon and catalog readers are named by family")
  // A real daemon on the family first: its clients reach it through the published pipe and the handshake.
  const served = spawn(process.execPath, [resolve("scripts/windows-host/serve-fake-catalog.mjs"), family], { stdio: ["ignore", "pipe", "inherit"] })
  await new Promise<void>((done, fail) => {
    served.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("serving")) done() })
    served.once("exit", (code) => fail(new Error(`the daemon exited ${code}`)))
  })
  const client = await connectDaemon(family, 5_000)
  assert.equal(client.stats.pid, served.pid, "a client reaches the daemon serving the family, through its handshake")
  client.close()
  const gone = publishedFamilyPipe(family)
  served.kill()
  await new Promise((done) => served.once("exit", done))
  assert.ok(gone, "the daemon published its pipe")
  await assert.rejects(connectDaemon(family, 3_000), "a daemon ended outright leaves a name that reaches nothing")
  const syncd = drawFamilyPipe(family)
  publishFamilyPipe(family, syncd)
  folders.push(familyFile(family))
  const sessionsImpostor = await impostor(syncd.pipe)
  await assert.rejects(connectDaemon(family, 3_000), "no daemon is taken for the impostor")
  await sessionsImpostor.close()
  assert.ok(onlyGreetings(sessionsImpostor.heard()), `the sessions impostor heard only nonces: ${JSON.stringify(sessionsImpostor.heard().slice(0, 200))}`)
  retractFamilyPipe(family, syncd)
  // Its claim, and record locks: a file in this user's folder opened with no sharing, never a pipe's name.
  const claim = await claimDaemon(family)
  await assert.rejects(claimDaemon(family), DaemonAlreadyServing, "one claim at a time")
  await claim.release()
  await (await claimDaemon(family)).release()
  const recordLock = join(scratch, "records", "one.lock")
  const held = await takeLock(recordLock)
  assert.ok(held, "the record's lock is taken")
  assert.equal(await takeLock(recordLock), null, "and held")
  assert.equal(await probeLock(recordLock), "held")
  await held.release()
  assert.equal(await probeLock(recordLock), "free")
  console.log("ok   the sessions daemon's pipe proves itself; its claim and record locks are files no other account can open")

  // Programs found only where another account can't put them. A second account owns C:\opt\homebrew\bin (which
  // Windows reads `/opt/homebrew/bin` as) and plants pwsh.exe and git.exe there, first on PATH; a folder made under
  // C:\ by anyone inherits write for every authenticated user, and holds another pwsh.exe, second.
  assert.match((await windowsHelperLines(["sid"]))?.[0] ?? "", /^S-1-5-21-/, "the helper names this user's SID")
  const planted = "C:\\opt\\homebrew\\bin"
  const open = "C:\\mako-open-" + randomUUID().slice(0, 8)
  const other = `makoplant${Math.floor(Math.random() * 1e5)}`
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  await run(join(system32, "net.exe"), ["user", other, `Mk!${randomUUID().replaceAll("-", "")}a9Z`, "/add", "/y"])
  try {
    await mkdir(planted, { recursive: true })
    await mkdir(open, { recursive: true })
    await run(join(system32, "icacls.exe"), [planted, "/setowner", other])
    await run(join(system32, "icacls.exe"), [planted, "/grant", `${other}:(OI)(CI)F`])
    for (const name of ["pwsh.exe", "git.exe"]) await copyFile(join(system32, "cmd.exe"), join(planted, name))
    await copyFile(join(system32, "cmd.exe"), join(open, "pwsh.exe"))
    assert.match((await windowsHelperLines(["trusted", join(planted, "pwsh.exe")]))?.[0] ?? "", /^untrusted (owned by another|writable by)/, "the planted program isn't trusted")
    assert.match((await windowsHelperLines(["trusted", join(open, "pwsh.exe")]))?.[0] ?? "", /^untrusted writable by S-1-5-11/, "a folder under C:\\ is writable by every authenticated user")
    assert.match((await windowsHelperLines(["trusted", join(system32, "cmd.exe")]))?.[0] ?? "", /^trusted .*cmd\.exe [0-9a-f]{8}:[0-9a-f]{16}$/i)
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path"
    const env = { ...process.env, [pathKey]: [planted, open, process.env[pathKey]].join(";") }
    for (const name of ["pwsh", "git"]) {
      const found = resolveExecutable(name, env)
      assert.ok(found && !found.toLowerCase().startsWith(planted.toLowerCase()) && !found.toLowerCase().startsWith(open.toLowerCase()), `${name} isn't taken from a folder another account can write: ${found}`)
    }
    assert.ok(!terminalShell(env).file.toLowerCase().startsWith("c:\\opt"), "a terminal never opens the planted pwsh")
    const { stdout } = await hostCommand("git", ["--version"], { env, timeout: 20_000 })
    assert.match(stdout, /^git version/, `Git ran, not what was planted: ${stdout.slice(0, 120)}`)
    // And a POSIX path, which Windows reads from the drive's root, is never started.
    await assert.rejects(hostCommand("/opt/homebrew/bin/git", ["--version"], { timeout: 20_000 }), "a path with no drive is no program")
  } finally {
    await rm("C:\\opt", { recursive: true, force: true }).catch(() => undefined)
    await rm(open, { recursive: true, force: true }).catch(() => undefined)
    await run(join(system32, "net.exe"), ["user", other, "/delete"]).catch(() => undefined)
  }
  console.log("ok   no program is taken from a folder another account can write: not C:\\opt\\homebrew\\bin, not one under C:\\")

  // The program file itself, and where a folder really is. A folder only administrators, SYSTEM and this user may write,
  // outside the profile, holds three programs: one any user may write (an ACE on the file, as a file moved in keeps),
  // one the folder's inherit-only grant to every user hands down, and one with no grant of its own. A junction to a
  // folder every user may write is followed to where it leads.
  const sid = (await windowsHelperLines(["sid"]))?.[0] ?? ""
  const guarded = "C:\\mako-guarded-" + randomUUID().slice(0, 8)
  const handsDown = "C:\\mako-handsDown-" + randomUUID().slice(0, 8)
  const target = "C:\\mako-open-target-" + randomUUID().slice(0, 8)
  const junction = "C:\\mako-junction-" + randomUUID().slice(0, 8)
  const tools = "C:\\mako-tools-" + randomUUID().slice(0, 8)
  const besideDll = "C:\\mako-dll-" + randomUUID().slice(0, 8)
  const icacls = join(system32, "icacls.exe")
  try {
    for (const folder of [guarded, handsDown, target, besideDll]) await mkdir(folder, { recursive: true })
    for (const folder of [guarded, handsDown])
      await run(icacls, [folder, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", `*${sid}:(OI)(CI)F`])
    // Every user may write what's made in `handsDown` from now on, though not `handsDown` itself.
    await run(icacls, [handsDown, "/grant", "*S-1-5-32-545:(OI)(IO)M"])
    await copyFile(join(system32, "cmd.exe"), join(guarded, "pwsh.exe"))
    await copyFile(join(system32, "cmd.exe"), join(guarded, "kept.exe"))
    await run(icacls, [join(guarded, "pwsh.exe"), "/grant", "*S-1-5-32-545:M"])
    await copyFile(join(system32, "cmd.exe"), join(handsDown, "git.exe"))
    await copyFile(join(system32, "cmd.exe"), join(target, "kept.exe"))
    await run(join(system32, "cmd.exe"), ["/d", "/c", "mklink", "/J", junction, target])
    const verdict = async (path: string) => (await windowsHelperLines(["trusted", path]))?.[0] ?? ""
    assert.match(await verdict(join(guarded, "kept.exe")), /^trusted .*kept\.exe [0-9a-f]{8}:[0-9a-f]{16}$/i, "a program no one else may write, in a guarded folder, where it really is")
    assert.match(await verdict(join(guarded, "pwsh.exe")), /^untrusted writable by S-1-5-32-545 /, "a program every user may write")
    assert.match(await verdict(join(handsDown, "git.exe")), /^untrusted writable by S-1-5-32-545 /, "a folder that hands every user write on its files")
    assert.match(await verdict(join(junction, "kept.exe")), /^untrusted writable by S-1-5-11 /i, "a junction every user may repoint, to a folder every user may write")
    // A junction any user may repoint, in a folder any user may write, to the guarded folder: refused though its
    // target is clean, since it could lead elsewhere once asked about.
    await mkdir(tools, { recursive: true })
    await run(join(system32, "cmd.exe"), ["/d", "/c", "mklink", "/J", join(tools, "link"), guarded])
    assert.match(await verdict(join(tools, "link", "kept.exe")), /^untrusted writable by S-1-5-11 /i, "a junction on a path any user may change is refused, its target clean or not")
    // A DLL beside a clean program, which Windows loads from its folder first, that any user may write.
    await run(icacls, [besideDll, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", `*${sid}:(OI)(CI)F`])
    await copyFile(join(system32, "cmd.exe"), join(besideDll, "kept.exe"))
    await copyFile(join(system32, "version.dll"), join(besideDll, "loose.dll"))
    await run(icacls, [join(besideDll, "loose.dll"), "/grant", "*S-1-5-32-545:M"])
    assert.match(await verdict(join(besideDll, "kept.exe")), /^untrusted writable by S-1-5-32-545 .*loose\.dll/i, "a program beside a DLL any user may write")
    // The file's identity as the helper reads it is Node's dev and ino, so a kept verdict knows its file.
    const realGit = resolveExecutable("git")
    assert.ok(realGit, "Git is found")
    const said = parseVerdict(await verdict(realGit))
    assert.ok(said?.trusted, `Git is trusted: ${JSON.stringify(said)}`)
    assert.equal(said.identity, identityOf(said.real), "the helper's file identity is Node's dev:ino")
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path"
    assert.equal(resolveExecutable("kept", { ...process.env, [pathKey]: join(tools, "link") }), null, "nothing is found through a junction any user may repoint")
    const env = { ...process.env, [pathKey]: [guarded, handsDown, junction, process.env[pathKey]].join(";") }
    const pwsh = resolveExecutable("pwsh", env)
    assert.ok(pwsh && !pwsh.toLowerCase().startsWith(guarded.toLowerCase()), `the writable pwsh.exe is passed by: ${pwsh}`)
    const git = resolveExecutable("git", env)
    assert.ok(git && !git.toLowerCase().startsWith(handsDown.toLowerCase()), `the git.exe its folder hands write on is passed by: ${git}`)
    assert.equal(resolveExecutable("kept", env)?.toLowerCase(), join(guarded, "kept.exe").toLowerCase(), "the guarded program is found, by where it really is")
  } finally {
    await rm(junction, { force: true, recursive: false }).catch(() => undefined)
    await rm(join(tools, "link"), { force: true, recursive: false }).catch(() => undefined)
    for (const folder of [guarded, handsDown, target, tools, besideDll]) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log("ok   refused: a program file anyone may write, one a folder hands write on, a junction anyone may repoint (even to a clean folder), a DLL anyone may write beside a program; the helper's file identity is Node's")


  // The driver broker's pipe, which each task's worker reaches with its grant: the grant carries the pipe's secret,
  // a connection without the handshake is answered nothing, and one that proves itself is answered by the broker
  // (here that there is no driver), its token read only then.
  const broker = new DriverBroker({ socket: async () => null })
  const grant = await broker.grant("a task")
  assert.match(grant.broker, /^\\\\\.\\pipe\\mako-control-[0-9a-f]{32}$/)
  assert.match(grant.proof ?? "", /^[0-9a-f]{64}$/, "a grant carries its broker pipe's secret")
  const unproven = await new Promise<string>((done) => {
    let said = ""
    const socket = connect(grant.broker)
    socket.on("data", (chunk: Buffer) => (said += chunk.toString()))
    socket.on("close", () => done(said))
    socket.on("error", () => undefined)
    socket.write(`${JSON.stringify({ token: grant.token })}\n`)
  })
  assert.equal(unproven, "", "the broker answers nothing without the handshake")
  await assert.rejects(connectBrokeredDriver(grant), DriverNotDispatchedError, "through the handshake the broker itself answers: no driver here, nothing dispatched")
  await assert.rejects(connectBrokeredDriver({ ...grant, proof: "0".repeat(64) }), DriverNotDispatchedError, "a wrong secret reaches no broker")
  await broker.close()
  console.log("ok   the driver broker's pipe proves itself; a grant carries its secret, and nothing is read without the handshake")

  console.log("PASS: Windows pipes prove their servers, and no planted program runs")
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  for (const folder of folders) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
}
