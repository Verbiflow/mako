import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { z } from "zod"
import { createServer } from "vite"
import { LiveHistoryReader } from "../electron/live-history-reader"
import { LiveHistoryReadSchema } from "../electron/contracts/live-history"
import type { LiveSnapshot } from "../electron/contracts/live-conversations"
import { startWebHost } from "../electron/web-host"
import { invokeRuntime, subscribeRuntime } from "../electron/runtime-connection"
import { SharedConversations } from "../electron/shared-conversations"
import { SessionMemory } from "../electron/session-memory"
import { withHostClient } from "../electron/host-client"
import { webHostProxy } from "../electron/web-dev-proxy.mjs"
import { auditSnapshot } from "./performance-audit-fixtures"

const root = await mkdtemp(join(tmpdir(), "mako-history-wire-"))
const socket = join(root, "owner.sock")
const peerSocket = join(root, "peer.sock")
const source = auditSnapshot(300, "claude", 150, 120 * 1024)
source.epoch = "paging-fixture"
source.session.title = "Review retained conversation history"
source.session.status = "ready"
source.requests.forEach(request => { request.status = "completed" })
const id = source.session.id
const reader = new LiveHistoryReader()
const client = randomUUID()
const methods = ["mako:live-read", "mako:live-snapshot", "mako:live-continue"]
const info = { protocol: 1 as const, instanceId: randomUUID(), pid: process.pid, version: "history-fixture", methods }
const file = async () => new Response(null, { status: 404 })
let reads = 0
const host = await startWebHost(socket, async (channel, args, _client, history) => {
  assert.equal(args[0], id)
  reads++
  const value = channel === "mako:live-read"
    ? await reader.read(id, LiveHistoryReadSchema.parse(args[1]), async () => source)
    : history ? reader.present(source) : source
  return JSON.stringify({ ok: true, value })
}, file, undefined, info)
const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: 1, label: "Fixture peer", socket: peerSocket })
memory.rememberJournal(id, socket)
let peer: Awaited<ReturnType<typeof startWebHost>> | undefined
const router = new SharedConversations(memory, event => peer?.conversationEvent(event))
peer = await startWebHost(peerSocket, (channel, args, client, history) => withHostClient(client ?? "fixture", async () => {
  const routed = await router.route(channel, args)
  assert.equal(routed.handled, true)
  return JSON.stringify({ ok: true, value: routed.handled ? routed.value : null })
}, history), file, undefined, { ...info, instanceId: randomUUID() })
let stop: (() => void) | undefined
let legacyStop: (() => void) | undefined
let vite: Awaited<ReturnType<typeof createServer>> | undefined
const until = async (test: () => boolean) => {
  const end = Date.now() + 10_000
  while (!test()) { assert.ok(Date.now() < end, "Transport did not settle"); await new Promise(resolve => setTimeout(resolve, 10)) }
}
try {
  await assert.rejects(invokeRuntime(socket, client, "mako:live-snapshot", [id]), /too large to load/)
  for (const target of [socket, peerSocket]) {
    const value = await invokeRuntime(target, client, "mako:live-snapshot", [id], 1, { history: true })
    // SAFETY: the fixture host only returns its typed source or reader projection.
    const snapshot = value as LiveSnapshot
    assert.ok(snapshot.history?.before)
    assert.ok(JSON.stringify(snapshot).length < 512 * 1024)
    const chunk = await invokeRuntime(target, client, "mako:live-read", [id, { kind: "earlier", token: snapshot.history.token, before: snapshot.history.before }], 1, { history: true })
    const frame = z.object({ data: z.string() }).parse(chunk)
    // SAFETY: the typed fixture reader above encoded this exact page.
    const page = JSON.parse(frame.data) as LiveSnapshot
    assert.equal(page.history!.blockEnd, snapshot.history.blockStart)
    assert.equal(page.requests, undefined, "Earlier content does not resend stale controls")
  }
  const events: unknown[] = []
  const oldEvents: unknown[] = []
  stop = subscribeRuntime(peerSocket, randomUUID(), event => events.push(event), () => {}, { history: true })
  legacyStop = subscribeRuntime(peerSocket, randomUUID(), event => oldEvents.push(event), () => {})
  await until(() => events.length > 0 && oldEvents.length > 0)
  host.event({ type: "live-batch", batch: { id, revision: 2, epoch: source.epoch,
    updates: [{ kind: "text", text: "x".repeat(700_000) }] } })
  await until(() => events.length > 1 && oldEvents.length > 1)
  assert.ok(JSON.stringify(events.at(-1)).includes('"historyChanged":true'))
  assert.ok(JSON.stringify(events.at(-1)).length < 512)
  assert.ok(JSON.stringify(oldEvents.at(-1)).length > 700_000, "Legacy subscribers retain ordinary events")
  console.log("PASS: actual desktop socket, existing shared-owner forwarding, opt-in compatibility and bounded event invalidation")

  if (process.argv.includes("--ui")) {
    vite = await createServer({ cacheDir: join(root, "vite"), plugins: [webHostProxy(peerSocket)], server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await vite.listen()
    await writeFile(join(root, "package.json"), JSON.stringify({ main: resolve("scripts/test-live-history-ui.mjs") }))
    const env = { ...process.env, MAKO_HISTORY_URL: vite.resolvedUrls!.local[0], MAKO_HISTORY_ROOT: root, MAKO_HISTORY_ID: id }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { env, stdio: "inherit" })
    const exit = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
    assert.equal(exit, 0, "Production UI proof passes")
  }
  console.log(`History wire requests: ${reads}`)
} finally {
  await vite?.close()
  stop?.(); legacyStop?.(); router.dispose(); peer?.close(); host.close(); memory.close()
  await rm(root, { recursive: true, force: true })
}
