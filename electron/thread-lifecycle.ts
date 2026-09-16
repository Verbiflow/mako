import type { LiveConversations } from "./live-conversations.js"
import type { NativeRequests } from "./native-requests.js"
import type { ThreadArchives } from "./thread-archives.js"
import type { ThreadRef } from "./shared.js"
import { threadArchiveKey, type ThreadTarget, type ThreadControls, type ArchiveCommand, type StopTarget } from "./contracts/thread-lifecycle.js"

interface ThreadLifecycleDependencies {
  live: LiveConversations
  archives: ThreadArchives
  native: Pick<NativeRequests, "list" | "editQueued">
  threads(): ThreadRef[]
  nativeToken(path: string): string | null
  abortNative(path: string, token: string): void
  external(path: string): boolean
}

export class ThreadLifecycle {
  private readonly dependencies: ThreadLifecycleDependencies
  constructor(dependencies: ThreadLifecycleDependencies) { this.dependencies = dependencies }

  private owner(target: ThreadTarget) {
    return this.dependencies.live.summaries().find((summary) => target.kind === "live"
      ? summary.session.id === target.id
      : target.kind === "file" ? summary.threadPath === target.path || summary.nativePaths?.includes(target.path)
      : summary.session.harness === target.provider && summary.session.nativeId === target.nativeId)
  }

  keys(target: ThreadTarget): string[] {
    const keys = [threadArchiveKey(target)]
    const ref = this.dependencies.threads().find((ref) => target.kind === "file" ? ref.path === target.path : target.kind === "native" && ref.harness === target.provider && ref.nativeId === target.nativeId)
    if (ref) {
      keys.push(threadArchiveKey({ kind: "file", path: ref.path }))
      if (ref.nativeId) keys.push(threadArchiveKey({ kind: "native", provider: ref.harness, nativeId: ref.nativeId }))
    }
    const owner = this.owner(target)
    if (owner) {
      keys.push(threadArchiveKey({ kind: "live", id: owner.session.id }))
      const snapshot = this.dependencies.live.snapshot(owner.session.id)
      for (const binding of snapshot?.control?.bindings ?? []) {
        if (binding.nativeId) keys.push(threadArchiveKey({ kind: "native", provider: binding.provider, nativeId: binding.nativeId }))
        if (binding.path) keys.push(threadArchiveKey({ kind: "file", path: binding.path }))
      }
    }
    return [...new Set(keys)]
  }

  controls(target: ThreadTarget): ThreadControls {
    const hidden = new Set(this.dependencies.archives.snapshot().keys)
    const archived = this.keys(target).some((key) => hidden.has(key))
    const owner = this.owner(target)
    const requestId = owner && this.dependencies.live.activeRequest(owner.session.id)
    if (owner && requestId) return { archived, stop: { kind: "live", id: owner.session.id, requestId }, external: false }
    const identity = target.kind === "native" ? target : { provider: owner?.session.harness, nativeId: owner?.session.nativeId }
    const ref = this.dependencies.threads().find((ref) => target.kind === "file" ? ref.path === target.path : ref.harness === identity.provider && ref.nativeId === identity.nativeId)
    const token = ref && this.dependencies.nativeToken(ref.path)
    return { archived, stop: ref && token ? { kind: "native", path: ref.path, token } : null, external: Boolean(owner?.session.connection === "disconnected" && ref && (ref.locked || ref.active || this.dependencies.external(ref.path))) }
  }

  archive(command: ArchiveCommand) {
    const owner = this.owner(command.target)
    const keys = this.keys(command.target)
    const receipt = this.dependencies.archives.set(
      command,
      keys
    )
    if (owner)
      this.dependencies.live.setArchived(
        owner.session.id,
        keys.some((key) => receipt.keys.includes(key))
      )
    return receipt
  }

  async stop(target: StopTarget): Promise<boolean> {
    if (target.kind === "live") return this.dependencies.live.stopRequest(target.id, target.requestId)
    if (this.dependencies.nativeToken(target.path) !== target.token) return false
    for (const request of this.dependencies.native.list())
      if (request.input.path === target.path && request.status === "queued")
        this.dependencies.native.editQueued({ requestId: request.input.id, expectedText: request.input.text, change: { kind: "pause" } })
    this.dependencies.abortNative(target.path, target.token)
    return true
  }
}
