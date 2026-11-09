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
    // A partial older record can name one known canonical internal Session;
    // carry that identity with its classification. Never use omission as an
    // equality wildcard against a different known placed worker.
    if (ref.sessionId === undefined) {
      const placed = known.filter(fact => fact.sessionId !== undefined)
      const first = placed[0]
      if (first && placed.every(fact => fact.sessionId === first.sessionId)) ref = { ...ref, sessionId: first.sessionId }
    }
    if (internalReviewSession(ref) && !known.some(fact => sameNativeSession(fact, ref))) {
      const { harness, nativeId, identity, sessionId, nativeAgent } = ref
      this.internal.set(key, [...known, { harness, nativeId, identity, sessionId, nativeAgent }])
      return ref
    }
    const fact = known.find(fact => sameNativeSession(fact, ref))
    if (fact && !internalReviewSession(ref)) return { ...ref, nativeAgent: fact.nativeAgent }
    // An ambiguous unplaced internal identity stays hidden without acquiring
    // any placed Session's authority.
    const first = known[0]
    return ref.sessionId === undefined && first && !internalReviewSession(ref) ? { ...ref, nativeAgent: first.nativeAgent } : ref
  }

  observe(ref: ThreadRef): ThreadRef {
    let classified = this.classify(ref)
    const held = this.paths.get(ref.path)
    // An ordinary partial update may preserve a placement this owner already
    // knows. Internal metadata must use its own canonical fact, never borrow
    // a worker's placed identity from the path.
    if (!internalReviewSession(classified) && classified.sessionId === undefined && held?.ref.sessionId !== undefined &&
        classified.harness === held.ref.harness && classified.nativeId === held.ref.nativeId && classified.identity === held.ref.identity)
      classified = { ...classified, sessionId: held.ref.sessionId }
    // Delayed metadata for a retired identity cannot take a new worker's path.
    if (held && !sameNativeSession(this.classify(held.ref), classified) && internalReviewSession(classified)) return classified
    if (!held || !sameNativeSession(held.ref, classified) || internalReviewSession(held.ref) !== internalReviewSession(classified))
      this.paths.set(ref.path, { ref: classified })
    else held.ref = classified
    return classified
  }

  version(path: string): NativeSessionVersion | undefined { return this.paths.get(path) }
  pathsOf(ref: ThreadRef): string[] { return [...this.paths].flatMap(([path, held]) => sameNativeSession(this.classify(held.ref), ref) ? [path] : []) }
  owns(ref: ThreadRef): boolean {
    const held = this.paths.get(ref.path)
    return !held || sameNativeSession(this.classify(held.ref), this.classify(ref))
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
