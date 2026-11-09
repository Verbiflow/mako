import { prefsStore } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import type { ThreadsState } from "@/state/thread-state"
import type { ThreadRef } from "@/lib/types"
import { internalReviewSession, sameNativeSession } from "@mako/host/contracts/thread-list"

interface NativeSessionVersion { ref: ThreadRef }
type InternalSessionFact = Pick<ThreadRef, "harness" | "nativeId" | "identity" | "sessionId" | "nativeAgent">

/**
 * Facts learned in this window survive older catalog snapshots and reads.
 * Classification belongs to native/placed identity; read ownership belongs
 * to one incarnation at a path. A new worker may reuse that path.
 * The host rehydrates durable native facts on a new window/host start.
 */
class NativeSessionRefs {
  private internal = new Map<string, InternalSessionFact[]>()
  private paths = new Map<string, NativeSessionVersion>()

  private key(ref: ThreadRef): string { return JSON.stringify([ref.harness, ref.nativeId, ref.identity]) }

  classify(ref: ThreadRef): ThreadRef {
    const key = this.key(ref)
    const known = this.internal.get(key) ?? []
    if (internalReviewSession(ref) && !known.some(fact => sameNativeSession(fact, ref))) {
      const { harness, nativeId, identity, sessionId, nativeAgent } = ref
      this.internal.set(key, [...known, { harness, nativeId, identity, sessionId, nativeAgent }])
      return ref
    }
    const fact = known.find(fact => sameNativeSession(fact, ref))
    return fact && !internalReviewSession(ref) ? { ...ref, nativeAgent: fact.nativeAgent } : ref
  }

  observe(ref: ThreadRef): ThreadRef {
    const classified = this.classify(ref)
    const held = this.paths.get(ref.path)
    // Delayed metadata for a retired identity cannot take a new worker's path.
    if (held && !sameNativeSession(held.ref, classified) && internalReviewSession(classified)) return classified
    if (!held || !sameNativeSession(held.ref, classified) || internalReviewSession(held.ref) !== internalReviewSession(classified))
      this.paths.set(ref.path, { ref: classified })
    else held.ref = classified
    return classified
  }

  version(path: string): NativeSessionVersion | undefined { return this.paths.get(path) }
  pathsOf(ref: ThreadRef): string[] { return [...this.paths].flatMap(([path, held]) => sameNativeSession(held.ref, ref) ? [path] : []) }
  owns(ref: ThreadRef): boolean {
    const held = this.paths.get(ref.path)
    return !held || sameNativeSession(held.ref, ref)
  }
  readable(ref: ThreadRef): boolean { return !internalReviewSession(this.classify(ref)) && this.owns(ref) }
}

export const nativeSessionRefs = new NativeSessionRefs()

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  opening: null,

  descriptors: [],
  run: null,
  working: {},
  attention: {},
  observed: {},
  externalActivity: {},
  converting: null,
  composerHarness: prefsStore.get().composerHarness ?? "claude",
  nativeRequests: [],
})

export const useThreads = createHook(threadsStore)
