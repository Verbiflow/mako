/**
 * The phone's Setup reads its page on mount: a read asked for before the screen installs its source (the page's effect
 * runs before the screen's) is made once the source arrives, and the page lands in the store without a focus.
 */
import assert from "node:assert/strict"
import type { Grant, SourceAsk } from "@mako/protocol/borrow"
import type { SetupView } from "@mako/host/contracts/setup"
import { webSetup, type BorrowGateway } from "@/web-client/setup-source"
import { readSetup, setSetupSource, setupStore } from "@/state/setup"

const page: SetupView = { project: "shop", root: "shop", repository: "acme/shop", places: [], at: 0 }
const asked: string[] = []

assert.equal(await readSetup("shop"), undefined, "nothing answers before a source is installed")
assert.equal(setupStore.get().byFolder.shop, undefined)

setSetupSource({
  read: async (project) => {
    asked.push(project)
    return page
  },
  act: async () => ({ done: true }),
})
await new Promise((done) => setTimeout(done, 0))
assert.deepEqual(asked, ["shop"], "the read asked before the source is made as it's installed, with no focus")
assert.deepEqual(setupStore.get().byFolder.shop, page)

await readSetup("shop")
assert.deepEqual(asked, ["shop", "shop"], "a focus reads again")
setSetupSource(undefined)

// The phone's own source: the account broker's lists, read and built here, Decline and Stop sent back to it.
const NOW = Date.UTC(2026, 10, 4, 12)
const grant: Grant = {
  id: "g-env",
  resource: { kind: "file", ref: ".env.local" },
  source: { kind: "device", device: "mac-1" },
  scope: { level: "project", account: "acct", repository: "acme/shop" },
  mode: "copy",
  access: "read",
  lifetime: { until: "revoked" },
  ask: "never",
  secret: true,
  grantedBy: { kind: "person", account: "acct" },
  grantedAt: NOW - 60_000,
  version: 1,
}
const sourceAsk: SourceAsk = {
  ask: "ask-1",
  grant: "g-env",
  resource: grant.resource,
  ref: ".env.local",
  mode: "copy",
  borrower: { account: "acct", repository: "acme/shop", thread: "t-1", place: { kind: "machine", machine: "m-1" } },
  why: "the app reads it",
  askPerson: true,
}
const calls: string[] = []
const gateway: BorrowGateway = {
  rest: async (method, path, body?) => {
    calls.push(`${method} ${path.split("?")[0]}${body ? ` ${JSON.stringify(body)}` : ""}`)
    const answer =
      path === "/v1/borrow/grants" ? { grants: [grant] }
      : path === "/v1/borrow/leases" ? { leases: [] }
      : path.startsWith("/v1/borrow/events") ? { events: [] }
      : path === "/v1/borrow/asks" ? { asks: [sourceAsk] }
      : undefined
    // As the gateway answers: the response's JSON, parsed.
    return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer))
  },
}
const phone = webSetup(gateway, "acct", () => [{ id: "mac-1", name: "MacBook Pro", platform: "macOS 26.1" }], () => NOW)
const built = await phone.read("shop")
assert.equal(built.repository, "acme/shop")
const lent = built.places.find((place) => place.id === "device:mac-1")!.parts.flatMap((part) => part.rows).find((row) => row.name === ".env.local")!
assert.equal(lent.action, "stop")
assert.deepEqual(built.places.find((place) => place.id === "cloud")!.asks.map((entry) => entry.id), ["ask-1"])
calls.length = 0
assert.deepEqual(await phone.act("shop", { act: "answer", ask: "ask-1", answer: "allow-thread" }), { done: false, why: "Allow it on the Mac that holds it: only its source can say yes." })
assert.deepEqual(await phone.act("shop", { act: "answer", ask: "ask-1", answer: "decline" }), { done: true })
assert.deepEqual(await phone.act("shop", { act: "row", place: "device:mac-1", row: lent.id, action: "stop" }), { done: true })
assert.deepEqual(calls, ['POST /v1/borrow/asks/ask-1 {"answer":"no","by":{"kind":"person","account":"acct"}}', "DELETE /v1/borrow/grants/g-env"])
console.log("Setup on the phone: the first read waits for the source and is made when it arrives; the page is built from the account broker, and Decline and Stop go back to it")
