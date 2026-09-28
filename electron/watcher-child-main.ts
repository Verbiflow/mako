import parcel, { type AsyncSubscription } from "@parcel/watcher"
import { WatcherRequestSchema, type WatcherReply } from "./contracts/watcher-child.js"

/*
 * @parcel/watcher's FSEvents backend races its own callback thread on
 * unsubscribe and when a watched root is deleted (still so in 2.6.0), which
 * corrupts the heap of whatever process hosts it. It runs here so that a
 * crash costs a restart of this child, not the app.
 */

const subscriptions = new Map<number, Promise<AsyncSubscription | undefined>>()

function reply(message: WatcherReply): void {
  if (process.connected) process.send?.(message)
}

process.on("message", (raw) => {
  const request = WatcherRequestSchema.safeParse(raw)
  if (!request.success) return
  const { id } = request.data
  if (request.data.t === "unsub") {
    const subscription = subscriptions.get(id)
    subscriptions.delete(id)
    void subscription?.then((current) => current?.unsubscribe()).catch(() => {})
    return
  }
  const subscription = parcel
    .subscribe(request.data.root, (error, events) => {
      if (!subscriptions.has(id)) return
      if (error) reply({ t: "dropped", id })
      else if (events.length) reply({ t: "events", id, events: events.map(({ path, type }) => ({ path, type })) })
    }, { ignore: request.data.ignore })
    .then((current) => {
      if (subscriptions.has(id)) reply({ t: "ready", id })
      return current
    }, (error: Error) => {
      subscriptions.delete(id)
      reply({ t: "failed", id, message: error.message })
      return undefined
    })
  subscriptions.set(id, subscription)
})

// The host is gone, or let this child go: nothing here outlives it.
process.on("disconnect", () => process.exit(0))
