import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { LiveConversations } from "../electron/live-conversations.js"
import { SessionMemory } from "../electron/session-memory.js"
import { SharedConversations } from "../electron/shared-conversations.js"
import { startWebHost } from "../electron/web-host.js"
import { invokeRuntime, subscribeRuntime, probeRuntime } from "../electron/runtime-connection.js"
import { runtimeLocation } from "../electron/runtime-service.js"
import { hostCallInputs } from "../electron/contracts/host-call-inputs.js"
import { planContinuation } from "../electron/contracts/thread-continuation.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { HostEvent, LiveDriverEvent, LiveSessionState } from "../electron/shared.js"

const root = mkdtempSync("/tmp/mako-peers-")
const ownerSocket = join(root, "owner.sock")
const desktopSocket = join(root, "desktop.sock")
const db = join(root, "memory.sqlite")
const ownerMemory = new SessionMemory(db, { pid: 101, startedAt: 1, label: "Mako's dev3 host", socket: ownerSocket }, { alive: () => true })
const desktopMemory = new SessionMemory(db, { pid: 102, startedAt: 2, label: "the installed Mako app", socket: desktopSocket }, { alive: () => true })
const wireSnapshot = z.object({ session: z.object({ id: z.string(), nativeId: z.string().optional() }), requests: z.array(z.object({ id: z.string(), status: z.string() })) })
const events: z.infer<ReturnType<typeof z.json>>[] = []
const prompts: string[] = []
const starts: string[] = []
const approvals: string[] = []
const cancellations: string[] = []
const finishes = new Map<string, () => void>()
const sessions = new Map<string, LiveSessionState>()
const emitters = new Map<string, (event: LiveDriverEvent) => void>()
const providers = ["codex", "claude", "cursor", "grok", "devin", "opencode"]
const drivers = new Map(providers.map((provider) => [provider, {
  provider, canResume: true, available: () => true,
  start: async (cwd, options) => {
    starts.push(provider)
    if (options.emit) emitters.set(options.conversationId, options.emit)
    const session: LiveSessionState = { id: options.conversationId, nativeId: `${provider}-native`, harness: provider, cwd, connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] }
    sessions.set(session.id, session)
    return session
  },
  prompt: async (id, text) => {
    prompts.push(text)
    const session = sessions.get(id)!
    emitters.get(id)?.({ type: "live-session", session: { ...session, status: "running" } })
    emitters.get(id)?.({ type: "live-update", id, update: { kind: "text", text: `${text} streamed` } })
    await new Promise<void>((resolve) => { finishes.set(id, resolve) })
    emitters.get(id)?.({ type: "live-session", session: { ...session, status: "ready", lastStop: "cancelled" } })
  },
  permission: async (_id, requestId) => { approvals.push(requestId) },
  cancel: async (id) => { cancellations.push(id); finishes.get(id)?.() },
  close: async (id) => { finishes.get(id)?.() },
  setMode: async () => {},
  checkpoint: async () => "checkpoint",
} satisfies ProviderLiveDriver]))
let ownerHost: Awaited<ReturnType<typeof startWebHost>>
const owner = new LiveConversations({ appPath: root, root: join(root, "owner"), memory: ownerMemory, driver: (provider) => drivers.get(provider), history: async () => null, nativePath: (session) => join(root, `${session.harness}.jsonl`), checkpoint: async () => "checkpoint", resumeVerdict: async () => ({ kind: "resumable", record: "same" }), emit: (event: HostEvent) => ownerHost?.event(event), providerWarmLimit: 10 })
const router = new SharedConversations(desktopMemory, (event) => { events.push(event); desktopHost?.conversationEvent(event) })
let desktopHost: Awaited<ReturnType<typeof startWebHost>>
const info = (pid: number) => ({ protocol: 1 as const, instanceId: randomUUID(), pid, version: "fixture", methods: Object.keys(hostCallInputs) })
const absentFile = async () => new Response(null, { status: 404 })
let snapshotIdentityCase: "normal" | "missing" | "conflicting" | "inactive" = "normal"
async function ownerCall(channel: string, args: unknown[]) {
  let value
  switch (channel) {
    case "mako:live-snapshot": {
      const [id] = hostCallInputs[channel].parse(args)
      const snapshot = await owner.refreshedSnapshot(id)
      value = snapshot && snapshotIdentityCase !== "normal" ? {
        ...snapshot,
        session: { ...snapshot.session, nativeId: snapshotIdentityCase === "conflicting" ? "different-native" : undefined },
        control: snapshot.control && { ...snapshot.control, activeBindingId: snapshotIdentityCase === "inactive" ? "different-binding" : snapshot.control.activeBindingId },
      } : snapshot
      break
    }
    case "mako:live-prompt": { const [id, requestId, text, attachments, tuning] = hostCallInputs[channel].parse(args); value = owner.submit(id, requestId, text, attachments, tuning); break }
    case "mako:live-permission": { const [id, requestId, response] = hostCallInputs[channel].parse(args); value = await owner.permission(id, requestId, response); break }
    case "mako:live-cancel": { const [id] = hostCallInputs[channel].parse(args); value = await owner.cancel(id); break }
    case "mako:live-close": { const [id] = hostCallInputs[channel].parse(args); value = await owner.close(id); break }
    case "mako:live-fork": { const [id, input] = hostCallInputs[channel].parse(args); value = owner.fork(id, input); break }
    default: throw new Error(`Unexpected method ${channel}`)
  }
  return JSON.stringify({ ok: true, value })
}
async function until(predicate: () => boolean, reason: string) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, reason)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
let closeClient: (() => void) | undefined
try {
  ownerHost = await startWebHost(ownerSocket, ownerCall, absentFile, undefined, info(101))
  desktopHost = await startWebHost(desktopSocket, async (channel, args) => {
    const routed = await router.route(channel, args)
    assert.equal(routed.handled, true, "desktop must never start a second driver")
    return JSON.stringify({ ok: true, value: routed.handled ? routed.value : null })
  }, absentFile, undefined, info(102))
  const client = randomUUID()
  const received: z.infer<ReturnType<typeof z.json>>[] = []
  closeClient = subscribeRuntime(desktopSocket, client, (packet) => {
    if (packet.channel === "event") received.push(packet.payload)
  }, () => {})
  for (const provider of providers) {
    const id = randomUUID()
    await owner.start(provider, root, { conversationId: id })
    await until(() => owner.snapshot(id)?.session.connection === "connected", `${provider} connects`)
    assert.deepEqual(planContinuation({ path: `/fixture/${provider}`, harness: provider, nativeId: `${provider}-native`, cwd: root, locked: true }, {
      attached: owner.connectedSession(provider, `${provider}-native`), live: { available: true, canResume: true }, nativeInstalled: true, running: false, external: "open",
    }), { transport: "attached", provider, conversationId: id }, "a local connected owner wins over an external-process probe for every provider")
    assert.equal(await router.attachment(provider, `${provider}-native`), id)
    const [a, b] = await Promise.all([router.attach(provider, `${provider}-native`), router.attach(provider, `${provider}-native`)])
    assert.equal(wireSnapshot.parse(a).session.id, id)
    assert.equal(wireSnapshot.parse(b).session.id, id, "two windows attach to the same conversation")
    snapshotIdentityCase = "missing"
    assert.equal(wireSnapshot.parse(await router.attach(provider, `${provider}-native`)).session.id, id, "durable active binding identifies a disconnected summary")
    snapshotIdentityCase = "conflicting"
    await assert.rejects(router.attach(provider, `${provider}-native`), /owner changed/, "conflicting native identity remains refused")
    snapshotIdentityCase = "inactive"
    await assert.rejects(router.attach(provider, `${provider}-native`), /owner changed/, "an inactive binding cannot attest current ownership")
    snapshotIdentityCase = "normal"

    assert.equal(desktopMemory.heldBy(provider, `${provider}-native`)?.conversationId, id)
    const requestId = randomUUID()
    await Promise.all([
      invokeRuntime(desktopSocket, client, "mako:live-prompt", [id, requestId, `${provider} reply`]),
      invokeRuntime(desktopSocket, client, "mako:live-prompt", [id, requestId, `${provider} reply`]),
    ])
    await until(() => prompts.includes(`${provider} reply`), "owner receives the reply")
    assert.equal(prompts.filter((text) => text === `${provider} reply`).length, 1, "duplicate delivery executes once")
    assert.equal(starts.filter((name) => name === provider).length, 1, "no extra provider process")
    await assert.rejects(invokeRuntime(desktopSocket, client, "mako:live-prompt", [id, requestId, "different input"]), /different content/)
    const queuedId = randomUUID()
    await invokeRuntime(desktopSocket, client, "mako:live-prompt", [id, queuedId, `${provider} next`])
    assert.equal(owner.snapshot(id)?.requests.find((request) => request.id === queuedId)?.status, "queued")
    const binding = owner.snapshot(id)?.control?.activeBindingId ?? id
    emitters.get(binding)?.({ type: "live-permission", request: { id: "approval", sessionId: binding, title: "Fixture approval", options: [{ optionId: "allow", name: "Allow" }] } })
    owner.snapshot(id)
    await until(() => received.some((event) => JSON.stringify(event).includes('"approval"')), "permission streams through desktop")
    await invokeRuntime(desktopSocket, client, "mako:live-permission", [id, "approval", { kind: "choice", optionId: "allow" }])
    assert.equal(owner.snapshot(id)?.permissions.length, 0)
    await invokeRuntime(desktopSocket, client, "mako:live-cancel", [id])
    assert.ok(cancellations.includes(binding))
    await until(() => owner.snapshot(id)?.session.status !== "running", "stop reaches owner")
    assert.ok(received.some((event) => JSON.stringify(event).includes(requestId)), "request updates reach the desktop client")
    assert.equal(desktopMemory.heldBy(provider, `${provider}-native`)?.hostLabel, "Mako's dev3 host", "desktop never steals the lease")
    owner.clearQueue(id)
    assert.equal(owner.hibernateIfIdle(id), true)
    await until(() => owner.snapshot(id)?.session.connection === "hibernated", "owner hibernates")
    assert.equal(desktopMemory.heldBy(provider, `${provider}-native`), null)
    assert.equal(await router.attachment(provider, `${provider}-native`), id, "hibernation keeps the journal reachable")
    const reloadedRouter = new SharedConversations(desktopMemory, () => {})
    assert.equal(wireSnapshot.parse(await reloadedRouter.attach(provider, `${provider}-native`)).session.id, id, "a new desktop connection finds the sleeping owner")
    reloadedRouter.dispose()
    const wakingId = randomUUID()
    await invokeRuntime(desktopSocket, client, "mako:live-prompt", [id, wakingId, `${provider} wake`])
    await until(() => prompts.includes(`${provider} wake`), "the original owner wakes its provider")
    assert.equal(starts.filter((name) => name === provider).length, 2, "one wake on the original host")
    await invokeRuntime(desktopSocket, client, "mako:live-cancel", [id])
    await until(() => owner.snapshot(id)?.session.status !== "running", "woken turn stopped")
    await invokeRuntime(desktopSocket, client, "mako:live-close", [id])
    assert.equal(desktopMemory.heldBy(provider, `${provider}-native`), null)
    assert.ok(desktopMemory.routeForConversation(id), "journal route survives provider close")
    if (provider === "codex") {
      const forkId = randomUUID()
      const fork = wireSnapshot.parse(await invokeRuntime(desktopSocket, client, "mako:live-fork", [id, {
        id: forkId, provider, point: { kind: "before-run", requestId },
      }]))
      assert.equal(fork.session.nativeId, undefined, "a new fork has no provider session yet")
      const reopened = new SharedConversations(desktopMemory, () => {})
      try {
        const result = await reopened.route("mako:live-snapshot", [forkId])
        assert.ok(result.handled, "an unsent fork remains routable after the receiving host reloads")
        await reopened.route("mako:live-prompt", [forkId, randomUUID(), "fork first reply"])
        await until(() => prompts.some((text) => text.includes("fork first reply")), "the fork's first send reaches its journal owner")
        await reopened.route("mako:live-cancel", [forkId])
        await reopened.route("mako:live-close", [forkId])
      } finally { reopened.dispose() }
    }
  }
  assert.equal(approvals.length, providers.length)
  assert.deepEqual(ownerHost.clients(), [], "peer subscriptions are observers, never shutdown-acknowledging windows")
  assert.deepEqual(await router.route("mako:boot", []), { handled: false }, "workspace and lifecycle calls stay local")
  assert.deepEqual(await router.route("mako:live-start", []), { handled: false }, "new conversations stay local")

  const missingLocation = runtimeLocation(join(root, "missing-ledger"))
  mkdirSync(missingLocation.directory, { recursive: true, mode: 0o700 })
  const missingMemory = new SessionMemory(db, { pid: 505, startedAt: 5, label: "Mako with a missed ledger write", socket: missingLocation.socket }, { alive: () => true })
  const missingId = randomUUID()
  const missingHost = await startWebHost(missingLocation.socket, async (channel, args) => {
    if (channel === "mako:live-locate") {
      const [provider, nativeId] = hostCallInputs[channel].parse(args)
      if (provider !== "fixture" || nativeId !== "missing-native") return JSON.stringify({ ok: true, value: null })
      missingMemory.hold(provider, nativeId, missingId)
      return JSON.stringify({ ok: true, value: missingId })
    }
    assert.equal(channel, "mako:live-snapshot")
    return JSON.stringify({ ok: true, value: { session: { id: missingId, harness: "fixture", nativeId: "missing-native" }, requests: [] } })
  }, absentFile, undefined, info(505))
  try {
    assert.equal(desktopMemory.heldBy("fixture", "missing-native"), null)
    assert.equal(wireSnapshot.parse(await router.attach("fixture", "missing-native")).session.id, missingId, "discovery repairs a missing ledger entry through the connected owner")
    assert.equal(desktopMemory.heldBy("fixture", "missing-native")?.conversationId, missingId)
  } finally {
    missingHost.close()
    missingMemory.close()
    rmSync(missingLocation.directory, { recursive: true, force: true })
  }

  // Losing the event transport must announce an outage and resubscribe before
  // a UI reconciles an uncertain request. No mutation is replayed by the router.
  // An already-running build can be attached without a migration or restart.
  const legacyLocation = runtimeLocation(join(root, "legacy"))
  mkdirSync(legacyLocation.directory, { recursive: true, mode: 0o700 })
  const legacyMemory = new SessionMemory(db, { pid: 303, startedAt: 3, label: "Mako's older dev host" }, { alive: () => true })
  const legacyId = randomUUID()
  legacyMemory.hold("fixture", "legacy-native", legacyId)
  let legacyAcknowledgments = 0
  const legacyShutdownId = randomUUID()
  const legacyHost = await startWebHost(legacyLocation.socket, async (channel, args) => {
    if (channel === "mako:live-fork") {
      const [, input] = hostCallInputs[channel].parse(args)
      return JSON.stringify({ ok: true, value: { session: { id: input.id, harness: input.provider }, requests: [] } })
    }
    if (channel === "mako:shutdown-ack") {
      assert.deepEqual(args, [legacyShutdownId])
      legacyAcknowledgments++
      return JSON.stringify({ ok: true })
    }
    return JSON.stringify({ ok: true, value: {
    session: { id: legacyId, harness: "fixture", nativeId: "legacy-native" }, requests: [],
  } })
  }, absentFile, undefined, { ...info(303), methods: ["mako:live-snapshot", "mako:shutdown-ack"] })
  try {
    assert.equal(wireSnapshot.parse(await router.attach("fixture", "legacy-native")).session.id, legacyId)
    assert.equal(desktopMemory.routeForConversation(legacyId)?.socket, legacyLocation.socket)
    const legacyForkId = randomUUID()
    await router.route("mako:live-fork", [legacyId, { id: legacyForkId, provider: "fixture", point: { kind: "before-run", requestId: randomUUID() } }])
    assert.equal(desktopMemory.routeForConversation(legacyForkId)?.socket, legacyLocation.socket, "an older owner's unsent fork keeps its endpoint")
    legacyHost.event({ type: "app-shutdown", requestId: legacyShutdownId, action: "restart" })
    await until(() => legacyAcknowledgments === 1, "legacy host shutdown is not blocked by its observer")
    assert.ok(legacyMemory.heldBy("fixture", "legacy-native") === null, "discovery never takes the hold")
  } finally {
    legacyHost.close()
    legacyMemory.close()
    rmSync(legacyLocation.directory, { recursive: true, force: true })
  }

  // A dev profile can exit while idle. Wake that same profile and journal,
  // using a real detached fixture host process through ensureRuntime.
  const restartRoot = join(root, "restart-owner")
  mkdirSync(restartRoot, { recursive: true })
  const restartLocation = runtimeLocation(restartRoot)
  const restartId = randomUUID()
  writeFileSync(join(restartRoot, "fixture.json"), JSON.stringify({ id: restartId, ledger: db }))
  const registration = new SessionMemory(db, { pid: 404, startedAt: 4, label: "dev3", socket: restartLocation.socket, launch: {
    dataRoot: restartRoot, executable: process.execPath, cwd: process.cwd(), profile: "dev3",
    args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/shared-conversation-owner.mjs", import.meta.url))],
  } }, { alive: () => false })
  registration.hold("fixture", "restart-native", restartId)
  registration.close()
  let restartedPid: number | undefined
  try {
    assert.equal(wireSnapshot.parse(await router.attach("fixture", "restart-native")).session.id, restartId)
    const probe = await probeRuntime(restartLocation.socket)
    assert.equal(probe.state, "ready")
    if (probe.state === "ready") restartedPid = probe.info.pid
    assert.ok(restartedPid && restartedPid !== process.pid, "the original profile runs in its own process")
    const requestId = randomUUID()
    await Promise.all([router.route("mako:live-prompt", [restartId, requestId, "wake and continue"]), router.route("mako:live-prompt", [restartId, requestId, "wake and continue"])])
    const saved = z.array(z.object({ id: z.string() })).parse(JSON.parse(readFileSync(join(restartRoot, "requests.json"), "utf8")))
    assert.deepEqual(saved, [{ id: requestId }], "wake preserves command identity across both hosts")
  } finally {
    if (restartedPid) {
      process.kill(restartedPid, "SIGTERM")
      await until(() => { try { process.kill(restartedPid!, 0); return false } catch { return true } }, "restarted fixture exits")
    }
    rmSync(restartLocation.directory, { recursive: true, force: true })
  }

  const before = prompts.length
  ownerHost.close()
  await until(() => events.some((event) => JSON.stringify(event).includes('"connected":false')), "peer disconnect reported")
  const lastRoute = desktopMemory.routeForSession("opencode", "opencode-native")!
  await assert.rejects(router.route("mako:live-prompt", [lastRoute.conversationId, randomUUID(), "not dispatched"]), /restarting/)
  await new Promise((resolve) => setTimeout(resolve, 300))
  rmSync(ownerSocket, { force: true })
  ownerHost = await startWebHost(ownerSocket, ownerCall, absentFile, undefined, info(101))
  await until(() => events.some((event) => JSON.stringify(event).includes('"connected":true')), "peer reconnect reported")
  assert.equal(prompts.length, before, "a reconnect itself never resends prompts")
  console.log("Shared conversations: six providers, same owner, concurrent attach, duplicate sends, queued replies, approvals, stop, close, hibernation, old-host discovery, real-process host wake, event forwarding and reconnect")
} finally {
  closeClient?.()
  router.dispose()
  desktopHost?.close()
  ownerHost?.close()
  owner.stop()
  ownerMemory.close()
  desktopMemory.close()
  rmSync(root, { recursive: true, force: true })
}
