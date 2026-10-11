import { channel, type ChannelListener } from "node:diagnostics_channel"

/**
 * One kind of message published across the process on a Node diagnostics
 * channel, so whatever produces it needs no handle on whoever keeps it: a
 * decoder reports an unknown record, a spawner a child, any module a log
 * line, and the host or process that owns the state subscribes.
 *
 * Publishing with nobody subscribed costs one property read, and nothing is
 * built for it. A subscriber must not throw: Node rethrows it on the next
 * tick as an uncaught exception. Anything else in the process can listen by
 * name (`diagnostics_channel.subscribe("mako:host-log", …)`), which is how a
 * test or a debugging session watches the host without changing it.
 */
export interface Topic<T> {
  /** Whether anyone subscribes; check it before building a costly message. */
  readonly heard: boolean
  publish(message: T): void
  /** Returns what ends the subscription. */
  subscribe(listener: (message: T) => void): () => void
}

export function topic<T>(name: `mako:${string}`): Topic<T> {
  const named = channel(name)
  return {
    get heard() {
      return named.hasSubscribers
    },
    publish(message) {
      if (named.hasSubscribers) named.publish(message)
    },
    subscribe(listener) {
      const heard: ChannelListener = (message) => {
        // SAFETY: a `mako:` channel is written only through this topic's `publish`, which takes a `T`.
        listener(message as T)
      }
      named.subscribe(heard)
      return () => named.unsubscribe(heard)
    },
  }
}
