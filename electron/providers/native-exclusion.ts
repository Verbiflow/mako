import type { ProviderLiveDriver, ProviderStartOptions } from "./live-driver.js"
import type { LiveSessionState } from "../shared.js"

type ExclusiveSession = Awaited<ReturnType<NonNullable<ProviderLiveDriver["startExclusive"]>>>

/** One lifecycle for a native lease, across every registry consumer. The
 * adapter's native authority supplies exclusivity; this map does not. A
 * cleanup failure retains the lease so another executor cannot take over
 * while foreground/children might still be running. */
export function withNativeExclusion(driver: ProviderLiveDriver): ProviderLiveDriver {
  const startExclusive = driver.startExclusive
  const steer = driver.steer
  const compaction = driver.compaction
  if (driver.nativeExclusion.kind !== "atomic" || !startExclusive) return driver
  const sessions = new Map<string, Promise<ExclusiveSession>>()
  const closing = new Map<string, Promise<void>>()
  const held = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    if (closing.has(id)) throw new Error("The native session is closing. No input was dispatched.")
    const session = sessions.get(id)
    if (!session) throw new Error("The native execution lease is unavailable. No input was dispatched.")
    const opened = await session
    await opened.lease.assertHeld()
    // close may have started while a native assertion was in flight.
    if (closing.has(id) || sessions.get(id) !== session)
      throw new Error("The native session changed during ownership verification. No input was dispatched.")
    // Check and invoke in one job; do not yield between the owner fence and
    // dispatch. The native authority still fences actual native mutations.
    return operation()
  }
  const close = (id: string): Promise<void> => {
    const pending = closing.get(id)
    if (pending) return pending
    const session = sessions.get(id)
    // A refused acquisition owns no native process. Outer admission may ask
    // for cleanup after any failed start; never forward it to an external owner.
    if (!session) return Promise.resolve()
    const operation = Promise.resolve().then(async () => {
      // Opening is also owned. A close during acquisition waits for its result.
      const opened = await session.catch(() => undefined)
      if (opened) {
        await driver.close(id)
        await opened.lease.release()
      }
      if (sessions.get(id) === session) sessions.delete(id)
    }).finally(() => {
      if (closing.get(id) === operation) closing.delete(id)
    })
    closing.set(id, operation)
    return operation
  }
  const start = async (cwd: string, options: ProviderStartOptions): Promise<LiveSessionState> => {
    const id = options.conversationId
    if (sessions.has(id) || closing.has(id)) throw new Error("This native binding already has an execution owner.")
    const operation = Promise.resolve().then(() => startExclusive.call(driver, cwd, options))
    sessions.set(id, operation)
    let opened: ExclusiveSession
    try { opened = await operation } catch (error) {
      if (sessions.get(id) === operation) sessions.delete(id)
      throw error
    }
    try {
      if (opened.session.id !== id || opened.session.harness !== driver.provider)
        throw new Error("The native lease belongs to a different session.")
      return await held(id, async () => opened.session)
    } catch (error) {
      // close owns release, including a concurrent close during acquisition.
      await close(id)
      throw error
    }
  }
  return {
    ...driver, start, close,
    prompt: (id, ...args) => held(id, () => driver.prompt(id, ...args)),
    permission: (id, ...args) => held(id, () => driver.permission(id, ...args)),
    setMode: (id, ...args) => held(id, () => driver.setMode(id, ...args)),
    cancel: id => held(id, () => driver.cancel(id)),
    steer: steer && ((id, ...args) => held(id, () => steer.call(driver, id, ...args))),
    compaction: compaction?.kind === "supported"
      ? { kind: "supported", start: (id, actionId) => held(id, () => compaction.start(id, actionId)) }
      : compaction,
  }
}
