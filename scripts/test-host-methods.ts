import assert from "node:assert/strict"
import { HostMethods, type RoutedCall } from "@mako/host/transport/methods"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { EncodedAnswer } from "@mako/host/contracts/runtime-value"

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

console.log("Host methods: values encoded once, encoded and routed answers carried unread and unpaged")
