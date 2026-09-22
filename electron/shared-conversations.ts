import type { LiveSnapshot } from "./contracts/live-conversations.js"
import { randomUUID } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import type { OwnerResolution } from "./contracts/thread-continuation.js"
import type { SessionMemory, ConversationRoute, ConversationEndpoint } from "./session-memory.js"
import { ensureRuntime, runtimeLocation } from "./runtime-service.js"
import { invokeRuntime, probeRuntime, subscribeRuntime, RuntimeDisconnectedError } from "./runtime-connection.js"

const snapshotIdentity = z.object({
  session: z.object({ id: z.string(), harness: z.string(), nativeId: z.string().optional() }),
  control: z.object({
    activeBindingId: z.string(),
    bindings: z.array(z.object({ id: z.string(), provider: z.string(), nativeId: z.string().optional() })),
  }).optional(),
})
const shutdownRequest = z.object({ type: z.literal("app-shutdown"), requestId: z.string() })
const batchIdentity = z.object({ type: z.literal("live-batch"), batch: z.object({ id: z.string() }) })
const liveTarget = z.object({ kind: z.literal("live"), id: z.string() })

// Only conversation operations cross hosts. Workspace state, app lifecycle,
// provider discovery and new conversations stay on the receiving host.
const conversationCalls = new Set([
  "mako:live-continue", "mako:live-snapshot", "mako:live-state", "mako:live-prompt", "mako:live-permission",
  "mako:live-mode", "mako:live-cancel", "mako:live-close", "mako:live-edit-queued",
  "mako:live-clear-queue", "mako:live-earlier", "mako:live-bind", "mako:read-live-file",
  "mako:live-delegate", "mako:live-child-cancel", "mako:live-merge-fork",
  "mako:live-rewind-preview", "mako:live-rewind", "mako:live-action",
  "mako:live-action-acknowledge", "mako:live-fork", "mako:live-transfer",
])

type WireValue = z.infer<ReturnType<typeof z.json>>
type SharedSnapshot = LiveSnapshot | WireValue
export type ConversationRoutingResult = { handled: false } | { handled: true; value: WireValue | undefined }
interface Peer {
  ids: Set<string>
  stop?: () => void
  retry?: ReturnType<typeof setTimeout>
  handshake?: ReturnType<typeof setTimeout>
  ready: Promise<void>
  resolveReady(): void
  disconnected: boolean
  connecting: boolean
  targetedContinuation: boolean
  observerSupported: boolean
  generation: number
  retryDelayMs: number
}

/** A second UI controls the original journal and driver through their host. */
export class SharedConversations {
  private readonly client = randomUUID()
  private readonly peers = new Map<string, Peer>()
  private closed = false
  private readonly waking = new Map<string, Promise<boolean>>()
  private readonly memory: SessionMemory
  private readonly emit: (event: WireValue) => void
  private readonly local?: { snapshot(id: string): LiveSnapshot | null; find(provider: string, nativeId: string): LiveSnapshot | null }
  private readonly discoveries = new Map<string, Promise<ConversationRoute | null>>()

  constructor(
    memory: SessionMemory,
    emit: (event: WireValue) => void,
    privateLocal?: { snapshot(id: string): LiveSnapshot | null; find(provider: string, nativeId: string): LiveSnapshot | null },
  ) {
    this.memory = memory
    this.emit = emit
    this.local = privateLocal
  }

  /** One resolution owns discovery, subscription and snapshot identity. */
  async resolve(provider: string, nativeId: string, discover = true): Promise<OwnerResolution<SharedSnapshot>> {
    try {
      let route = this.memory.routeForSession(provider, nativeId)
      const local = !route || this.memory.isLocal(route.socket) ? this.local?.find(provider, nativeId) : null
      if (local) return this.attached(local, provider, nativeId)
      if (!route && (discover || this.memory.heldBy(provider, nativeId))) route = await this.discover(provider, nativeId)
      if (!route) {
        if (this.memory.heldBy(provider, nativeId)) return this.unavailable()
        return { kind: "unowned" }
      }
      if (this.memory.isLocal(route.socket)) {
        const snapshot = this.local?.snapshot(route.conversationId)
        return snapshot ? this.attached(snapshot, provider, nativeId) : this.unavailable()
      }
      if (!await this.reachable(route)) return this.unavailable()
      await this.follow(route)
      const value = await invokeRuntime(route.socket, this.client, "mako:live-snapshot", [route.conversationId])
      if (value == null) return this.unavailable()
      const identity = snapshotIdentity.parse(value)
      if (identity.session.id !== route.conversationId) return this.unavailable()
      return this.attached(value, provider, nativeId, this.peers.get(route.socket)?.targetedContinuation ?? false)
    } catch {
      // Failure is not evidence that a new writer may start.
      return this.unavailable()
    }
  }

  private unavailable(): Extract<OwnerResolution<SharedSnapshot>, { kind: "unavailable" }> {
    return { kind: "unavailable", reason: "The Mako owner of this session is temporarily unavailable. Your conversation is saved; retry when it reconnects." }
  }

  private attached(snapshot: SharedSnapshot, provider: string, nativeId: string, targeted = true): OwnerResolution<SharedSnapshot> {
    const identity = snapshotIdentity.parse(snapshot)
    const binding = identity.control?.bindings.find((entry) => entry.provider === provider && entry.nativeId === nativeId)
    const current = identity.session.harness === provider && identity.session.nativeId === nativeId
    if (!binding && !current) return this.unavailable()
    if (!targeted && binding && identity.control?.activeBindingId !== binding.id)
      return { kind: "unavailable", reason: "Update the Mako host running this conversation to continue an earlier native session." }
    return { kind: "attached", conversationId: identity.session.id, provider, snapshot,
      bindingId: targeted ? binding?.id : undefined }
  }

  private discover(provider: string, nativeId: string): Promise<ConversationRoute | null> {
    const key = JSON.stringify([provider, nativeId])
    let pending = this.discoveries.get(key)
    if (!pending) {
      pending = this.discoverOwner(provider, nativeId).finally(() => this.discoveries.delete(key))
      this.discoveries.set(key, pending)
    }
    return pending
  }

  /** Registered hosts first; temporary-directory scanning only repairs legacy holds. */
  private async discoverOwner(provider: string, nativeId: string): Promise<ConversationRoute | null> {
    const hold = this.memory.heldBy(provider, nativeId)
    const sockets = new Set(this.memory.hostSockets())
    if (hold) {
      for (const name of (await readdir(tmpdir())).filter((name) => /^mako-host-[a-f0-9]{16}$/.test(name)).slice(0, 128))
        sockets.add(join(tmpdir(), name, "host.sock"))
    }
    const candidates = [...sockets]
    const deadline = Date.now() + 3_000
    let uncertain = false
    for (let offset = 0; offset < candidates.length; offset += 8) {
      if (Date.now() >= deadline) throw new RuntimeDisconnectedError(false)
      const results = await Promise.all(candidates.slice(offset, offset + 8).map(async (socket) => {
        try {
          const probe = await probeRuntime(socket, { timeoutMs: Math.max(1, Math.min(750, deadline - Date.now())) })
          if (probe.state === "absent") return null
          if (probe.state !== "ready") { uncertain = true; return null }
          if (probe.info.pid === process.pid) return null
          await this.validateSocket(socket)
          if (hold && probe.info.pid === hold.hostPid) return { socket, hold }
          if (hold || !probe.info.methods.includes("mako:live-locate")) return null
          if (Date.now() >= deadline) { uncertain = true; return null }
          const id = z.string().nullable().parse(await invokeRuntime(socket, this.client, "mako:live-locate", [provider, nativeId], 1, { timeoutMs: Math.max(1, Math.min(750, deadline - Date.now())) }))
          const located = this.memory.heldBy(provider, nativeId)
          if (!id) return null
          if (located?.conversationId !== id || located.hostPid !== probe.info.pid) { uncertain = true; return null }
          return { socket, hold: located }
        } catch { uncertain = true; return null }
      }))
      const candidate = results.find((result) => result !== null)
      if (candidate) {
        const route = { conversationId: candidate.hold.conversationId, provider, nativeId, socket: candidate.socket }
        if (this.memory.rememberRoute(route, candidate.hold)) return route
        throw new RuntimeDisconnectedError(false)
      }
    }
    if (uncertain || hold) throw new RuntimeDisconnectedError(false)
    return null
  }

  async route(channel: string, args: unknown[]): Promise<ConversationRoutingResult> {
    let id: string | undefined
    if (conversationCalls.has(channel)) id = z.string().parse(args[0])
    else if (channel === "mako:thread-controls" || channel === "mako:thread-stop") {
      const target = liveTarget.safeParse(args[0])
      if (target.success) id = target.data.id
    }
    if (!id) return { handled: false }
    const route = this.memory.routeForConversation(id)
    if (!route) return { handled: false }
    try {
    if (!await this.reachable(route)) throw new RuntimeDisconnectedError(false)
    await this.follow(route)
    // Preserve the original request id. The owner's journal settles a replay;
    // this router never retries a mutation after an ambiguous transport error.
    const value = await invokeRuntime(route.socket, this.client, channel, args)
    if (channel === "mako:live-fork") {
      const fork = snapshotIdentity.parse(value)
      const input = z.object({ id: z.string(), provider: z.string() }).parse(args[1])
      if (fork.session.id !== input.id || fork.session.harness !== input.provider)
        throw new Error("The conversation owner returned a different fork")
      // A fork has a journal before it has a native provider session. Record
      // its endpoint even when the owner is an older build without this table.
      this.memory.rememberJournal(fork.session.id, route.socket)
      await this.follow({ conversationId: fork.session.id, socket: route.socket })
    }
    return { handled: true, value }

    } catch (error) {
      if (error instanceof RuntimeDisconnectedError)
        throw new RuntimeDisconnectedError(error.unconfirmed, id)
      throw error
    }
  }

  private async reachable(route: ConversationEndpoint): Promise<boolean> {
    const peer = this.peers.get(route.socket)
    if (peer && !peer.disconnected && !peer.connecting) return true
    const probe = await probeRuntime(route.socket, { timeoutMs: 1_000 })
    if (probe.state === "ready") {
      await this.validateSocket(route.socket)
      return probe.info.methods.includes("mako:live-snapshot")
    }
    if (probe.state !== "absent") return false
    const launch = this.memory.runtimeLaunch(route.socket)
    if (!launch) return false
    if (runtimeLocation(launch.dataRoot).socket !== route.socket)
      throw new Error("The saved conversation host does not match its data directory")
    let waking = this.waking.get(route.socket)
    if (!waking) {
      const env = { ...process.env, MAKO_PROFILE: launch.profile, ELECTRON_RUN_AS_NODE: undefined, MAKO_STANDALONE: undefined }
      // Only an absent socket permits a restart. ensureRuntime retains the
      // owner's data root and single-instance lock; an unreachable live host
      // never authorizes a replacement or a different provider process.
      waking = ensureRuntime({ ...launch, env }).then(() => true).finally(() => this.waking.delete(route.socket))
      this.waking.set(route.socket, waking)
    }
    return waking
  }

  private async validateSocket(socket: string): Promise<void> {
    const [directory, endpoint] = await Promise.all([lstat(dirname(socket)), lstat(socket)])
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      !endpoint.isSocket() || (endpoint.mode & 0o077) !== 0 ||
      (process.getuid && (directory.uid !== process.getuid() || endpoint.uid !== process.getuid())))
      throw new Error("The conversation host socket is not private to this user")
  }

  private async follow(route: ConversationEndpoint): Promise<void> {
    let peer = this.peers.get(route.socket)
    if (!peer) {
      try { await this.validateSocket(route.socket) }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          throw new RuntimeDisconnectedError(false)
        throw error
      }
      // Recheck after filesystem I/O: concurrent sends share one subscription.
      peer = this.peers.get(route.socket)
      if (!peer) {
        peer = { ids: new Set(), ready: Promise.resolve(), resolveReady: () => {}, disconnected: false, connecting: false, observerSupported: false, targetedContinuation: false, generation: 0, retryDelayMs: 1_000 }
        this.peers.set(route.socket, peer)
        this.connect(route.socket, peer)
      }
    }
    if (peer.disconnected && !peer.connecting) {
      clearTimeout(peer.retry)
      peer.stop?.()
      this.connect(route.socket, peer)
    }
    peer.ids.add(route.conversationId)
    // Subscribe before reading a snapshot or accepting a prompt, so no updates
    // can fall into a gap between the snapshot and event stream.
    await peer.ready
    if (this.closed || peer.disconnected) throw new RuntimeDisconnectedError(false)
  }

  private connect(socket: string, peer: Peer): void {
    if (this.closed) return
    const generation = ++peer.generation
    peer.connecting = true
    peer.ready = new Promise<void>((resolve) => { peer.resolveReady = resolve })
    let ended = false
    const disconnected = () => {
      if (ended || this.closed || peer.generation !== generation) return
      ended = true
      peer.connecting = false
      clearTimeout(peer.handshake)
      peer.stop?.()
      peer.resolveReady()
      if (!peer.disconnected) this.emit({ type: "live-owner-connection", ids: [...peer.ids], connected: false })
      peer.disconnected = true
      peer.retry = setTimeout(() => { this.connect(socket, peer) }, peer.retryDelayMs)
      peer.retryDelayMs = Math.min(10_000, peer.retryDelayMs * 2)
      peer.retry.unref()
    }
    peer.handshake = setTimeout(disconnected, 5_000)
    peer.handshake.unref()
    peer.stop = subscribeRuntime(socket, this.client, (packet) => {
      if (this.closed || peer.generation !== generation) return
      if (packet.channel === "ready") {
        peer.connecting = false
        peer.retryDelayMs = 1_000
        peer.targetedContinuation = packet.runtime?.methods.includes("mako:live-continue") ?? false
        peer.observerSupported = packet.runtime?.methods.includes("mako:live-attach") ?? false
        clearTimeout(peer.handshake)
        peer.resolveReady()
        if (peer.disconnected) {
          peer.disconnected = false
          this.emit({ type: "live-owner-connection", ids: [...peer.ids], connected: true })
        }
      } else if (packet.channel === "event") {
        const shutdown = shutdownRequest.safeParse(packet.payload)
        if (shutdown.success && !peer.observerSupported) {
          // Old hosts count every stream as a window. This observer owns no
          // drafts; acknowledge only its own client identity, never a UI's.
          void invokeRuntime(socket, this.client, "mako:shutdown-ack", [shutdown.data.requestId]).catch(() => {})
        }
        const event = batchIdentity.safeParse(packet.payload)
        if (event.success && peer.ids.has(event.data.batch.id) &&
          this.memory.routeForConversation(event.data.batch.id)?.socket === socket)
          this.emit(packet.payload)
      }
    }, disconnected, { observer: true })
  }

  dispose(): void {
    this.closed = true
    for (const peer of this.peers.values()) {
      clearTimeout(peer.retry)
      clearTimeout(peer.handshake)
      peer.stop?.()
      peer.resolveReady()
    }
    this.peers.clear()
  }
}
