import assert from "node:assert/strict"
import { HostMethods, type RoutedCall } from "@mako/host/transport/methods"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { EncodedAnswer } from "@mako/host/contracts/runtime-value"
import { FailedCalls, FAILED_CALL_FOLD_MS } from "@mako/host/transport/failed-calls"
import diagnostics_channel from "node:diagnostics_channel"
import { z } from "zod"

// Each answer is encoded once: a handler's value here, an answer already
// encoded (the owner's, or another call's) carried as its text, unread.

const presented: string[] = []
let routed: RoutedCall = { handled: false }
const methods = new HostMethods({
  fixtureDesk: false,
  route: async () => routed,
  presentHistory: (value) => {
    presented.push(JSON.stringify(value))
    return value
  },
  breadcrumb: () => {},
  declaring: async () => {},
  work: unwatchedWork,
})
const owners = '{ "spaced" : 1.50, "e": "\\u00e9" }'
methods.handle("mako:live-snapshot", (id: string) => id === "elsewhere" ? new EncodedAnswer(owners) : { id, history: { blocks: [] } })
methods.handle("mako:live-close", () => new EncodedAnswer(undefined))

assert.equal(await methods.invoke("mako:live-snapshot", ["here"], "web", true), '{"id":"here","history":{"blocks":[]}}', "a handler's value is encoded here")
assert.deepEqual(presented, ['{"id":"here","history":{"blocks":[]}}'], "and its history paged for a paging client")

assert.equal(await methods.invoke("mako:live-snapshot", ["elsewhere"], "web", true), owners, "an encoded answer crosses byte for byte")
assert.equal(presented.length, 1, "whoever encoded it paged it")
assert.equal(await methods.invoke("mako:live-close", ["any"], "web", true), undefined, "an encoded nothing is nothing")

routed = { handled: true, value: owners }
assert.equal(await methods.invoke("mako:live-snapshot", ["here"], "web", true), owners, "a routed answer crosses byte for byte")
assert.equal(presented.length, 1)

// A call that fails is said in the host's log, which counted nothing before: once a minute per failure, with its repeats.
const said: Array<{ message: string; channel?: string; reason?: string; repeats?: number }> = []
const LineSchema = z.object({ scope: z.string(), message: z.string(), fields: z.object({ channel: z.string().optional(), reason: z.string().optional(), repeats: z.number().optional() }).loose().optional() }).loose()
const heard: diagnostics_channel.ChannelListener = (raw) => {
  const line = LineSchema.parse(raw)
  if (line.scope === "methods") said.push({ message: line.message, ...line.fields })
}
diagnostics_channel.subscribe("mako:host-log", heard)
routed = { handled: false }
methods.handle("mako:live-cancel", () => { throw new Error("The conversation isn't open\nsecond line") })
await assert.rejects(methods.invoke("mako:live-cancel", ["c"], "web", false), /isn't open/, "the caller still hears the failure")
await assert.rejects(methods.invoke("mako:live-cancel", ["c"], "web", false))
assert.deepEqual(said.map(({ message, channel, reason }) => [message, channel, reason]), [["a call failed", "mako:live-cancel", "The conversation isn't open"]], "said once, by its first line")
let now = 0
const folded = new FailedCalls(() => now)
folded.note("mako:x", { error: new Error("busy") })
folded.note("mako:x", { error: new Error("busy") })
folded.note("mako:x", { error: new Error("busy") })
now = FAILED_CALL_FOLD_MS
folded.note("mako:x", { error: new Error("busy") })
assert.deepEqual(said.slice(1).map(({ repeats }) => repeats), [undefined, 2], "a minute later, with how many it folded")
diagnostics_channel.unsubscribe("mako:host-log", heard)

console.log("Host methods: values encoded once, encoded and routed answers carried unread and unpaged; failed calls said in the log, folded a minute")
