// The driver broker against a fake daemon that speaks the real daemon's line
// protocol (metadata, list, session_begin on a kept connection, one call per
// connection) and keeps its rules: a session label belongs to the lease that
// first named it, a lease's sessions end when its connection closes, and a
// tree read replaces the window's snapshot: for everyone at an older daemon,
// only for the reading lease at one that says `snapshot_scope: "transport"`.
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ComputerDriverExitedError, DriverBroker, DriverNotDispatchedError, connectBrokeredDriver } from "../dist/host.js"

const root = await mkdtemp(join(tmpdir(), "mako-broker-test-"))
const socket = join(root, "daemon.sock")

/** `snapshotScope: "transport"` is a daemon with 0003-transport-scoped-snapshots; without it, an older one. */
function fakeDaemon({ snapshotScope, contract = "0.8.0" } = {}) {
  const state = {
    calls: [],
    leases: new Map(),
    sessions: new Map(),
    snapshot: new Map(),
    counter: 0,
    warmups: 0,
    connections: new Set(),
    lists: 0,
  }
  const reply = (connection, body) => connection.write(`${JSON.stringify(body)}\n`)
  const result = (structuredContent, extra = {}) => ({ ok: true, result: { content: [{ type: "text", text: "done" }], structuredContent, ...extra } })
  const server = createServer((connection) => {
    state.connections.add(connection)
    connection.on("close", () => state.connections.delete(connection))
    connection.on("error", () => {})
    let buffer = ""
    let lease
    connection.on("data", async (chunk) => {
      buffer += chunk
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (request.method === "metadata")
          reply(connection, { ok: true, result: { driver_version: "0.28.2+fake", contract_version: contract, pid: process.pid, ...(snapshotScope && { snapshot_scope: snapshotScope }) } })
        else if (request.method === "list") {
          state.lists++
          reply(connection, {
            ok: true,
            result: {
              tool_observation_owner: "daemon",
              tools: ["list_windows", "get_window_state", "check_permissions", "wait", "get_session", "set_value"].map((name) => ({
                name,
                description: name,
                input_schema: { type: "object", properties: { session: { type: "string" } } },
                read_only: name !== "set_value",
              })),
            },
          })
        } else if (request.method === "session_begin") {
          lease = request.session_id
          state.leases.set(lease, true)
          connection.once("close", () => {
            state.leases.set(lease, false)
            for (const [label, owner] of state.sessions) if (owner === lease) state.sessions.delete(label)
          })
          reply(connection, { ok: true, result: { session_begin: true } })
        } else if (request.method === "call") {
          const { name, args, session_id } = request
          state.calls.push({ name, args, session_id, at: performance.now() })
          if (args.session) {
            const owner = state.sessions.get(args.session)
            if (owner && owner !== session_id) {
              reply(connection, { ok: true, result: { content: [{ type: "text", text: "session is not available to this transport" }], isError: true, structuredContent: { refusal: { code: "session_ended" } } } })
              continue
            }
            state.sessions.set(args.session, session_id)
          }
          if (name === "wait") {
            await delay(args.ms)
            reply(connection, result({ waited: args.ms }))
          } else if (name === "list_windows") reply(connection, result({ windows: [{ pid: 7, window_id: 70, app_name: "Fixture", title: "Fixture", is_on_screen: true, bounds: { x: 0, y: 0, width: 50, height: 40 } }] }))
          else if (name === "check_permissions") reply(connection, result({ screen_recording: true }))
          else if (name === "get_session") reply(connection, result({ session: args.session, owner: state.sessions.get(args.session) === session_id }))
          else if (name === "get_window_state") {
            if (args.max_dimension === 16) state.warmups++
            if (args.include_accessibility_tree === false) reply(connection, { ok: true, result: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], structuredContent: { app_name: "Fixture" } } })
            else {
              const id = `s${++state.counter}`
              state.snapshot.set(`${snapshotScope ? `${session_id}|` : ""}${args.pid}:${args.window_id}`, id)
              reply(connection, result({ snapshot_id: id, elements: [] }))
            }
          } else if (name === "set_value") {
            const [snapshot] = String(args.element_token).split(":")
            reply(connection, state.snapshot.get(`${snapshotScope ? `${session_id}|` : ""}${args.pid}:${args.window_id}`) === snapshot ? result({ status: "dispatched" }) : { ok: true, result: { content: [{ type: "text", text: "element_token is stale" }], isError: true, structuredContent: { refusal: { code: "stale_element_token" } } } })
          } else reply(connection, { ok: false, error: `Unknown tool ${name}`, exit_code: 64 })
        }
      }
    })
  })
  return {
    state,
    server,
    listen: () => new Promise((resolve) => server.listen(socket, resolve)),
    /** The daemon dies: its listener and every connection close. */
    stop: () => new Promise((resolve) => {
      for (const connection of state.connections) connection.destroy()
      server.close(() => resolve())
    }),
  }
}

let daemon = fakeDaemon()
await daemon.listen()
const lines = []
const broker = new DriverBroker({ socket: async () => socket, own: () => [7], log: (message, fields) => lines.push({ message, ...fields }) })
const ms = (since) => performance.now() - since
try {
  /* Leases are identities ----------------------------------------------------- */
  const first = await broker.connect({ kind: "agent", label: "agent one" })
  const second = await broker.connect({ kind: "agent", label: "agent two" })
  const shots = await broker.connect({ kind: "appshots", label: "appshots" }, { parallel: true })
  assert.deepEqual((await first.listTools()).map((tool) => tool.name).slice(0, 2), ["list_windows", "get_window_state"], "tools in MCP's shape")
  assert.equal((await first.listTools())[0].annotations.readOnlyHint, true)
  await broker.warm()
  assert.equal(daemon.state.warmups, 1, "the daemon's first picture is taken once")
  await Promise.all([broker.warm(), broker.warm()])
  assert.equal(daemon.state.warmups, 1, "and not again for the same daemon")
  assert.equal(daemon.state.lists, 1, "one tool list per daemon, however many leases")
  const named = await first.callTool("get_session", { session: "mako-one" })
  assert.equal(named.structuredContent.owner, true)
  const stolen = await second.callTool("get_session", { session: "mako-one" })
  assert.equal(stolen.isError, true, "another lease cannot use a session the first one named")
  const identities = new Set(daemon.state.calls.filter((call) => call.name === "get_session").map((call) => call.session_id))
  assert.equal(identities.size, 2, "each lease reaches the daemon under its own transport identity")

  /* No head-of-line blocking across consumers; order within a task ------------- */
  let since = performance.now()
  const slow = first.callTool("wait", { ms: 600 })
  await delay(20)
  await second.callTool("list_windows", {})
  const quick = ms(since)
  await shots.callTool("get_window_state", { pid: 7, window_id: 70, include_accessibility_tree: false })
  assert.ok(ms(since) < 300, `another task's read and an Appshot don't wait behind a slow call (${Math.round(ms(since))} ms)`)
  assert.ok(quick < 300)
  since = performance.now()
  const behind = first.callTool("list_windows", {})
  await behind
  assert.ok(ms(since) >= 450, `a task's own next call waits for its previous one (${Math.round(ms(since))} ms)`)
  await slow
  since = performance.now()
  await Promise.all([shots.callTool("wait", { ms: 300 }), shots.callTool("wait", { ms: 300 })])
  assert.ok(ms(since) < 500, `a parallel lease's reads overlap (${Math.round(ms(since))} ms)`)

  /* Supersession, at an older daemon ------------------------------------------ */
  assert.equal(broker.status().daemon.snapshots, "window", "a daemon that doesn't say keeps one snapshot per window")
  const notices = []
  first.onSuperseded((event) => notices.push(event))
  const read = await first.callTool("get_window_state", { pid: 7, window_id: 70 })
  await shots.callTool("get_window_state", { pid: 7, window_id: 70, include_accessibility_tree: false })
  assert.deepEqual(notices, [], "a picture replaces no snapshot")
  await shots.callTool("get_window_state", { pid: 7, window_id: 70, include_screenshot: false })
  assert.deepEqual(notices, [{ pid: 7, window_id: 70, by: "appshots" }], "an Appshot's tree read tells the task whose snapshot it replaced")
  const stale = await first.callTool("set_value", { pid: 7, window_id: 70, element_token: `${read.structuredContent.snapshot_id}:1`, value: "x" })
  assert.equal(stale.isError, true, "(the daemon refuses that task's token, as the notice said)")
  await first.callTool("get_window_state", { pid: 7, window_id: 70 })
  await first.callTool("get_window_state", { pid: 7, window_id: 70 })
  assert.equal(notices.length, 1, "a task's own reads tell nobody")

  /* Cancellation --------------------------------------------------------------- */
  const running = first.callTool("wait", { ms: 500 })
  const cancelled = new AbortController()
  const queued = first.callTool("wait", { ms: 50, tag: "never" }, { signal: cancelled.signal })
  await delay(20)
  cancelled.abort()
  await assert.rejects(queued, "a cancelled call rejects at once")
  await running
  await delay(20)
  assert.ok(!daemon.state.calls.some((call) => call.args.tag === "never"), "a call cancelled while queued is never sent")
  const abandoned = new AbortController()
  since = performance.now()
  const inFlight = first.callTool("wait", { ms: 400 }, { signal: abandoned.signal })
  await delay(30)
  abandoned.abort()
  await assert.rejects(inFlight)
  assert.ok(ms(since) < 200, "a cancelled in-flight call stops waiting at once")
  const after = performance.now()
  await first.callTool("list_windows", {})
  assert.ok(performance.now() - since >= 380, `the task's next call still waits for the daemon to finish the cancelled one (${Math.round(performance.now() - after)} ms queued)`)
  assert.ok(broker.status().recent.some((call) => call.abandoned), "the readout says the caller left it running")
  await assert.rejects(first.callTool("wait", { ms: 500 }, { timeout: 100 }), /didn't answer wait within/)
  await delay(450)

  /* Out of process: a task's worker -------------------------------------------- */
  const grant = await broker.grant("agent remote")
  const remote = await connectBrokeredDriver(grant)
  assert.equal((await remote.listTools()).length, 6)
  const remoteNotices = []
  remote.onSuperseded((event) => remoteNotices.push(event))
  const local = await first.callTool("list_windows", {})
  const relayed = await remote.callTool("list_windows", {})
  assert.deepEqual(relayed, local, "the relayed reply reads the same as one in process")
  await remote.callTool("get_window_state", { pid: 7, window_id: 70 })
  await second.callTool("get_window_state", { pid: 7, window_id: 70 })
  await delay(20)
  assert.deepEqual(remoteNotices, [{ pid: 7, window_id: 70, by: "agent" }], "a worker hears that another task replaced its snapshot")
  since = performance.now()
  const remoteSlow = remote.callTool("wait", { ms: 400 })
  await delay(20)
  await shots.callTool("list_windows", {})
  assert.ok(ms(since) < 200, "an Appshot doesn't wait behind a worker's slow call")
  await remoteSlow
  const refused = await remote.callTool("no_such_tool", {})
  assert.deepEqual(refused.structuredContent, { code: "tool_invocation_failed", exit_code: 64 }, "a daemon refusal reads as the proxy wrote it")
  const remoteClosed = new Promise((resolve) => remote.onClose(resolve))
  broker.revoke("agent remote")
  await remoteClosed
  await assert.rejects(connectBrokeredDriver(grant), DriverNotDispatchedError, "a revoked grant leases nothing")
  await assert.rejects(remote.callTool("list_windows", {}), DriverNotDispatchedError)

  /* The daemon restarts --------------------------------------------------------- */
  const closedLeases = []
  for (const [name, client] of [["first", first], ["second", second], ["appshots", shots]]) client.onClose(() => closedLeases.push(name))
  const lost = first.callTool("wait", { ms: 2000 })
  await delay(30)
  await daemon.stop()
  await assert.rejects(lost, ComputerDriverExitedError, "a call the daemon took when it died is reported as such")
  await delay(20)
  assert.deepEqual(closedLeases.sort(), ["appshots", "first", "second"], "every lease on it ends, so its consumer reconnects")
  // The replacement is a patched daemon, which keeps each lease's snapshots apart.
  daemon = fakeDaemon({ snapshotScope: "transport" })
  await daemon.listen()
  // With consumers about, the broker connects to the replacement on its own and warms it.
  const deadline = Date.now() + 5000
  while (broker.status().daemon.generation !== 2 && Date.now() < deadline) await delay(20)
  assert.equal(broker.status().daemon.generation, 2, "the broker reconnects without waiting for a call")
  assert.equal(lines.find((line) => line.message === "driver lost").leases, 3, "the loss counts the leases it ended")
  const reconnected = await broker.connect({ kind: "agent", label: "agent one" })
  await Promise.all([broker.connect({ kind: "agent", label: "agent two" }), broker.connect({ kind: "appshots", label: "appshots" }, { parallel: true })])
  await broker.warm()
  assert.equal(daemon.state.lists, 1, "one reconnect for everyone")
  assert.equal(daemon.state.warmups, 1, "and one warm-up for the new daemon")
  assert.equal((await reconnected.callTool("list_windows", {})).structuredContent.windows.length, 1)

  /* Per-lease snapshots, at a patched daemon ----------------------------------- */
  assert.equal(broker.status().daemon.snapshots, "lease", "the gate follows each daemon: this one keeps each lease's snapshots")
  assert.equal(reconnected.describe().snapshots, "lease")
  const appshotsAgain = await broker.connect({ kind: "appshots", label: "appshots" }, { parallel: true })
  const patchedNotices = []
  reconnected.onSuperseded((event) => patchedNotices.push(event))
  const supersededBefore = broker.status().totals.superseded
  const mine = await reconnected.callTool("get_window_state", { pid: 7, window_id: 70 })
  await appshotsAgain.callTool("get_window_state", { pid: 7, window_id: 70, include_screenshot: false })
  const patchedGrant = await broker.grant("agent patched")
  const worker = await connectBrokeredDriver(patchedGrant)
  assert.equal(worker.describe().snapshots, "lease", "a worker's lease says whose snapshots it reads")
  await worker.callTool("get_window_state", { pid: 7, window_id: 70 })
  await delay(20)
  assert.deepEqual(patchedNotices, [], "another consumer's tree read replaces nothing of this lease's")
  assert.equal(broker.status().totals.superseded, supersededBefore, "and nothing is tracked")
  const kept = await reconnected.callTool("set_value", { pid: 7, window_id: 70, element_token: `${mine.structuredContent.snapshot_id}:1`, value: "x" })
  assert.notEqual(kept.isError, true, "the earlier token still acts")
  broker.revoke("agent patched")
  await appshotsAgain.close()
  const status = broker.status()
  assert.equal(status.daemon.state, "connected")
  assert.equal(status.daemon.generation, 2)
  assert.equal(status.reconnects, 1)
  assert.equal(status.warm.state, "warm")
  assert.equal(status.consumers.length, 3)
  assert.ok(status.totals.superseded >= 2)
  assert.ok(!JSON.stringify(status).includes("Fixture"), "the readout names no window titles or contents")
  assert.ok(lines.some((line) => line.message === "driver lost") && lines.some((line) => line.message === "driver connected" && line.generation === 2))

  /* Shutdown -------------------------------------------------------------------- */
  const ended = new Promise((resolve) => reconnected.onClose(resolve))
  await broker.close()
  await ended
  await assert.rejects(broker.connect({ kind: "agent", label: "late" }), DriverNotDispatchedError)
  await delay(50)
  assert.ok([...daemon.state.leases.values()].every((open) => !open), "closing the broker ends every lease at the daemon")
  /* A daemon of another contract is refused ------------------------------------- */
  const foreignSocket = join(root, "foreign.sock")
  const foreign = fakeDaemon({ contract: "0.9.0" })
  await new Promise((resolve) => foreign.server.listen(foreignSocket, resolve))
  const refusals = []
  const strict = new DriverBroker({ socket: async () => foreignSocket, log: (message, fields) => refusals.push({ message, ...fields }) })
  await assert.rejects(strict.connect({ kind: "agent", label: "foreign" }), (error) => error instanceof DriverNotDispatchedError && /daemon contract 0\.9\.0.*speaks 0\.8\.x/.test(error.message), "refused, saying which contracts")
  await assert.rejects(strict.connect({ kind: "agent", label: "foreign" }), DriverNotDispatchedError)
  assert.equal(refusals.filter((line) => line.message === "driver refused").length, 1, "logged once")
  assert.ok(!foreign.state.calls.length, "nothing was dispatched")
  await delay(20)
  assert.ok([...foreign.state.leases.values()].every((open) => !open), "and the refused daemon holds no lease of the broker's")
  await strict.close()
  await foreign.stop()

  console.log(
    "driver broker: leases as identities, no head-of-line blocking, serial order per task, supersession notices at an older daemon and none at a patched one (a token survives other consumers' reads), cancellation, worker relay, revocation, one reconnect and one warm-up per daemon, a foreign contract refused, shutdown"
  )
} finally {
  await broker.close()
  await daemon.stop().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
