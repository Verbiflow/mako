import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { TerminalClients } from "../electron/terminal-clients.ts"
import {
  TerminalDaemonClient,
  terminalEndpoint,
} from "../electron/terminal-client.ts"
import {
  TERMINAL_FLOW_HIGH_BYTES,
  TERMINAL_OUTPUT_CHUNK_BYTES,
} from "../electron/terminal-protocol.ts"
import type { TerminalEvent } from "../electron/shared.ts"

const root = await mkdtemp(join(tmpdir(), "mako-terminal-"))
const stateDir = join(root, "state")
const entry = resolve("dist-electron/terminal-daemon.js")
const endpoint = terminalEndpoint(stateDir)
const child = spawn(
  process.execPath,
  [
    entry,
    "--endpoint",
    endpoint,
    "--state-dir",
    stateDir,
    "--build",
    "fixture-a",
  ],
  {
    stdio: "ignore",
  }
)

async function waitForSocket(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Terminal daemon exited with ${child.exitCode}`)
    try {
      await access(endpoint)
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }
  throw new Error("Terminal daemon socket did not appear")
}

function outputContaining(
  events: TerminalEvent[],
  marker: string
): Promise<void> {
  return new Promise((resolveOutput, rejectOutput) => {
    const interval = setInterval(() => {
      if (
        !events.some(
          (event) => event.type === "output" && event.data.includes(marker)
        )
      )
        return
      clearInterval(interval)
      clearTimeout(timer)
      resolveOutput()
    }, 10)
    const timer = setTimeout(() => {
      clearInterval(interval)
      rejectOutput(new Error(`Terminal output did not contain ${marker}`))
    }, 5_000)
  })
}

await waitForSocket()
const events: TerminalEvent[] = []
const first = new TerminalDaemonClient(entry, stateDir, (event) =>
  events.push(event)
)
const session = await first.create({
  cwd: root,
  cols: 80,
  rows: 24,
  title: "Test",
})
await first.attach(session.id)
const marker = `mako-terminal-${Date.now()}`
const seen = outputContaining(events, marker)
await first.write(session.id, `printf '${marker}\\n'\n`)
await seen
const snapshot = await first.attach(session.id)
assert.match(snapshot.data, new RegExp(marker))

events.length = 0
const flowMarker = `mako-flow-${Date.now()}`
const flowMarkerAt = Math.floor(flowMarker.length / 2)
await first.write(
  session.id,
  `node -e "process.stdout.write('x'.repeat(2000000)); console.log('${flowMarker.slice(0, flowMarkerAt)}'+'${flowMarker.slice(flowMarkerAt)}')"\n`
)
await new Promise((resolveWait) => setTimeout(resolveWait, 250))
const beforeAcknowledge = events
  .filter((event) => event.type === "output")
  .reduce((bytes, event) => bytes + Buffer.byteLength(event.data), 0)
assert.ok(
  beforeAcknowledge <=
    TERMINAL_FLOW_HIGH_BYTES + TERMINAL_OUTPUT_CHUNK_BYTES * 4,
  `flow control admitted ${beforeAcknowledge} bytes before acknowledgment`
)
assert.equal(
  events.some(
    (event) => event.type === "output" && event.data.includes(flowMarker)
  ),
  false
)
let flowSnapshotData = ""
for (let attempt = 0; attempt < 250; attempt += 1) {
  const latest = events.reduce(
    (sequence, event) =>
      event.type === "output" ? Math.max(sequence, event.sequence) : sequence,
    0
  )
  if (latest > 0) await first.acknowledge(session.id, latest)
  const current = await first.attach(session.id)
  flowSnapshotData = current.data
  await first.acknowledge(session.id, current.sequence)
  if (
    flowSnapshotData.includes(flowMarker) ||
    events.some(
      (event) => event.type === "output" && event.data.includes(flowMarker)
    )
  ) {
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
}
assert.equal(
  flowSnapshotData.includes(flowMarker) ||
    events.some(
      (event) => event.type === "output" && event.data.includes(flowMarker)
    ),
  true
)

await first.detach(session.id)
const detachedMarker = `mako-detached-${Date.now()}`
await first.write(session.id, `printf '${detachedMarker}\\n'\n`)
await new Promise((resolveWait) => setTimeout(resolveWait, 100))
const detachedSnapshot = await first.attach(session.id)
assert.match(detachedSnapshot.data, new RegExp(detachedMarker))
first.dispose()

// Two windows attach independently; closing one cannot steal or detach the other.
const ownedEvents = new Map<string, TerminalEvent[]>([
  ["left", []],
  ["right", []],
])
const ownerErrors: string[] = []
let pauseLeft = false
const owners = new TerminalClients(entry, stateDir, (event, owner) => {
  ownedEvents.get(owner)?.push(event)
  if (event.type === "output" && !(owner === "left" && pauseLeft))
    void owners.forOwner(owner).acknowledge(event.sessionId, event.sequence).catch((error) => {
      if (!(error instanceof Error && error.message === "Terminal client stopped")) ownerErrors.push(String(error))
    })
})
const left = owners.forOwner("left")
const right = owners.forOwner("right")
const rightSession = await right.create({
  cwd: root,
  cols: 80,
  rows: 24,
  title: "Other window",
})
await left.attach(session.id)
await right.attach(rightSession.id)
const ownerMarker = `owner-left-${Date.now()}`
const leftSeen = outputContaining(ownedEvents.get("left")!, ownerMarker)
await left.write(session.id, `printf '${ownerMarker}\\n'\n`)
await leftSeen
assert.equal(
  ownedEvents
    .get("right")
    ?.some(
      (event) => event.type === "output" && event.sessionId === session.id
    ),
  false
)
pauseLeft = true
ownedEvents.get("left")!.length = 0
const sharedTail = `shared-tail-${Date.now()}`
await left.write(
  session.id,
  `node -e "process.stdout.write('z'.repeat(600000)); console.log('${sharedTail.slice(0, 8)}'+'${sharedTail.slice(8)}')"\n`
)
await new Promise((resolveWait) => setTimeout(resolveWait, 200))
const rightSnapshot = await right.attach(session.id)
pauseLeft = false
const lastLeftSequence = ownedEvents
  .get("left")!
  .reduce(
    (sequence, event) =>
      event.type === "output" ? Math.max(sequence, event.sequence) : sequence,
    0
  )
await left.acknowledge(session.id, lastLeftSequence)
await outputContaining(ownedEvents.get("left")!, sharedTail)
const completeLeftOutput = ownedEvents
  .get("left")!
  .filter((event) => event.type === "output")
  .map((event) => event.data)
  .join("")
assert.ok(
  completeLeftOutput.includes("z".repeat(600000)),
  "Attaching a second window must not discard the first window's queued output"
)
assert.ok(rightSnapshot.sequence > 0)
await right.kill(rightSession.id)
owners.release("right")
const survivingMarker = `owner-survived-${Date.now()}`
const survivingSeen = outputContaining(
  ownedEvents.get("left")!,
  survivingMarker
)
await left.write(session.id, `printf '${survivingMarker}\\n'\n`)
await survivingSeen
owners.dispose()
assert.deepEqual(ownerErrors, [])
console.log(
  "terminal owners: simultaneous output and independent window cleanup passed"
)

// A single renderer subscribes to two shells concurrently. Neither attachment
// can steal the other's frames, resize target or flow-control credit.
const splitEvents: TerminalEvent[] = []
const splitErrors: string[] = []
let splitClient = new TerminalDaemonClient(entry, stateDir, (event) => {
  splitEvents.push(event)
  if (event.type === "output") void splitClient.acknowledge(event.sessionId, event.sequence).catch((error) => {
    if (!(error instanceof Error && error.message === "Terminal client stopped")) splitErrors.push(String(error))
  })
})
const splitA = await splitClient.create({ cwd: root, cols: 60, rows: 20, title: "Split A" })
const splitB = await splitClient.create({ cwd: root, cols: 90, rows: 30, title: "Split B" })
await splitClient.attach(splitA.id)
await splitClient.attach(splitB.id)
const started = performance.now()
await Promise.all([
  splitClient.write(splitA.id, `node -e "process.stdout.write('A'.repeat(1048576)); console.log('SPLIT_A_'+'DONE')"\n`),
  splitClient.write(splitB.id, `node -e "process.stdout.write('B'.repeat(1048576)); console.log('SPLIT_B_'+'DONE')"\n`),
])
await Promise.all([outputContaining(splitEvents, "SPLIT_A_DONE"), outputContaining(splitEvents, "SPLIT_B_DONE")])
const throughputMs = performance.now() - started
for (const [id, letter] of [[splitA.id, "A"], [splitB.id, "B"]]) {
  const data = splitEvents.filter((event) => event.type === "output" && event.sessionId === id).map((event) => event.type === "output" ? event.data : "").join("")
  assert.ok(data.includes(letter.repeat(1048576)), `Every byte reaches pane ${letter}`)
  assert.ok(!data.includes((letter === "A" ? "B" : "A").repeat(1000)), "Pane streams remain isolated")
}
await splitClient.resize(splitA.id, 55, 18)
const splitSizes = await splitClient.list()
assert.equal(splitSizes.find((s) => s.id === splitA.id)?.cols, 55)
assert.equal(splitSizes.find((s) => s.id === splitB.id)?.cols, 90)
// Real socket teardown/re-attachment keeps the same shell process and history.
for (let cycle = 0; cycle < 8; cycle++) {
  splitClient.dispose()
  splitClient = new TerminalDaemonClient(entry, stateDir, () => {})
  const [a, b] = await Promise.all([splitClient.attach(splitA.id), splitClient.attach(splitB.id)])
  assert.equal(a.session.status, "running")
  assert.equal(b.session.status, "running")
  assert.match(a.data, /SPLIT_A_DONE/)
  assert.match(b.data, /SPLIT_B_DONE/)
}
// Replay-safe filtering changes retained output only; live PTY traffic stays intact.
await splitClient.write(splitA.id, `printf '\\033[6n\\033[?2004$p\\033]2;fixture-title\\007FILTER_READY\\n'\n`)
await new Promise((resolveWait) => setTimeout(resolveWait, 100))
const filtered = await splitClient.attach(splitA.id)
assert.ok(!filtered.data.includes("\x1b[6n"))
assert.ok(!filtered.data.includes("\x1b[?2004$p"))
assert.match(filtered.data, /FILTER_READY/)
assert.equal(filtered.session.title, "fixture-title")
await splitClient.kill(splitA.id)
await splitClient.kill(splitB.id)
splitClient.dispose()
assert.deepEqual(splitErrors, [])
console.log(JSON.stringify({ splitBytes: 2 * 1048576, throughputMs: Math.round(throughputMs), socketRecoveryCycles: 8 }))

const secondEvents: TerminalEvent[] = []
const second = new TerminalDaemonClient(entry, stateDir, (event) =>
  secondEvents.push(event)
)
const sessions = await second.list()
assert.equal(
  sessions.some((entrySession) => entrySession.id === session.id),
  true
)
const reattached = await second.attach(session.id)
assert.match(reattached.data, new RegExp(survivingMarker))

const processSession = await second.create({
  cwd: root,
  cols: 80,
  rows: 24,
  title: "Process group",
})
await second.attach(processSession.id)
secondEvents.length = 0
await second.write(processSession.id, "sleep 30 & echo MAKO_CHILD:$!\n")
let childPid = 0
for (let attempt = 0; attempt < 250; attempt += 1) {
  const childOutput = secondEvents
    .filter((event) => event.type === "output")
    .map((event) => event.data)
    .join("")
  childPid = Number(/MAKO_CHILD:(\d+)/.exec(childOutput)?.[1])
  if (childPid > 1) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
}
assert.ok(childPid > 1)
await second.kill(processSession.id)
await new Promise((resolveWait) => setTimeout(resolveWait, 100))
assert.throws(() => process.kill(childPid, 0))

await second.kill(session.id)
assert.equal(
  second.daemonPid(),
  child.pid,
  "a client without a build accepts any daemon of its protocol"
)
const survivor = await second.create({
  cwd: root,
  cols: 80,
  rows: 24,
  title: "Survivor",
})
second.dispose()

// A host from another build retires the daemon in one connect: the daemon
// persists its sessions and leaves, a fresh one starts from this executable,
// and the same call completes against it. Scrollback survives; live shells
// are reported interrupted, never silently dropped.
const childExited = new Promise<void>((resolveExit) =>
  child.once("exit", () => resolveExit())
)
const third = new TerminalDaemonClient(entry, stateDir, () => {}, "fixture-b")
const afterReplacement = await third.list()
await childExited
assert.ok(
  third.daemonPid() && third.daemonPid() !== child.pid,
  "the outdated daemon was replaced"
)
assert.equal(
  afterReplacement.find((entrySession) => entrySession.id === survivor.id)
    ?.status,
  "interrupted"
)
const sameBuild = new TerminalDaemonClient(
  entry,
  stateDir,
  () => {},
  "fixture-b"
)
await sameBuild.list()
assert.equal(
  sameBuild.daemonPid(),
  third.daemonPid(),
  "a host of the same build keeps the daemon"
)
const replacementPid = third.daemonPid()
third.dispose()
sameBuild.dispose()
if (replacementPid) process.kill(replacementPid, "SIGTERM")
for (let attempt = 0; attempt < 100 && replacementPid; attempt += 1) {
  try {
    process.kill(replacementPid, 0)
  } catch {
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
}

// A daemon whose socket was rebound by a successor is unreachable. It leaves
// on its own and leaves the successor's endpoint in place.
if (process.platform !== "win32") {
  const orphanState = join(root, "orphan")
  const orphanEndpoint = terminalEndpoint(orphanState)
  const orphan = spawn(
    process.execPath,
    [entry, "--endpoint", orphanEndpoint, "--state-dir", orphanState],
    { stdio: "ignore" }
  )
  const orphanExited = new Promise<number | null>((resolveExit) =>
    orphan.once("exit", (code) => resolveExit(code))
  )
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(orphanEndpoint).then(() => true, () => false)) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  await rm(orphanEndpoint)
  await writeFile(orphanEndpoint, "successor")
  const exitCode = await Promise.race([
    orphanExited,
    new Promise<"timeout">((resolveWait) =>
      setTimeout(() => resolveWait("timeout"), 8_000)
    ),
  ])
  if (exitCode === "timeout") orphan.kill("SIGKILL")
  assert.equal(exitCode, 0, "an orphaned daemon exits by itself")
  assert.equal(await readFile(orphanEndpoint, "utf8"), "successor")
}

// A profile path too long for a Unix socket still gets a working terminal,
// with its socket in a private temp folder.
if (process.platform !== "win32") {
  const longState = join(root, "p".repeat(120), "terminal")
  const longEndpoint = terminalEndpoint(longState)
  assert.ok(Buffer.byteLength(longEndpoint) <= 104)
  assert.equal(dirname(dirname(longEndpoint)), tmpdir())
  assert.equal(terminalEndpoint(stateDir), join(stateDir, "daemon.sock"))
  const longEvents: TerminalEvent[] = []
  const longClient = new TerminalDaemonClient(entry, longState, (event) => longEvents.push(event))
  const longSession = await longClient.create({ cwd: root, cols: 80, rows: 24 })
  await longClient.attach(longSession.id)
  const longMarker = `mako-long-${Date.now()}`
  const longSeen = outputContaining(longEvents, longMarker)
  await longClient.write(longSession.id, `printf '${longMarker}\\n'\n`)
  await longSeen
  assert.equal((await stat(dirname(longEndpoint))).mode & 0o777, 0o700)
  const longPid = longClient.daemonPid()
  await longClient.kill(longSession.id)
  longClient.dispose()
  if (longPid) process.kill(longPid, "SIGTERM")
}
await rm(root, { recursive: true, force: true })

console.log("terminal daemon integration passed")
