/**
 * Setup away from the Mac, rendered: a laptop's browser reaches a project's Setup from Settings in its pane, and a page
 * built from the account broker alone draws only what it can do and says only what it can see. Every ask is listed
 * once however many folders hold it, and answering it clears it from all of them.
 */
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import type { Grant, SourceAsk } from "@mako/protocol/borrow"
import { partSummary, rowAction, type SetupView } from "@mako/host/contracts/setup"
import { PhoneSetup, SetupPage } from "@/components/setup/setup-page"
import { allAsks, answerAsk, readSetup, setSetupSource, setupStore } from "@/state/setup"
import { inboxCount, inboxModel } from "@/state/inbox"
import DeskSettings from "@/web-client/desk-settings"
import type { ScreenRoute } from "@/web-client/route"
import { Settings } from "@/web-client/settings"
import { SetupScreen } from "@/web-client/setup-screen"
import { webSetup, type BorrowGateway } from "@/web-client/setup-source"

const NOW = Date.UTC(2026, 10, 4, 12)
const MAC = "mac-1"
const grant: Grant = {
  id: "g-env",
  resource: { kind: "file", ref: ".env.local" },
  source: { kind: "device", device: MAC },
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
const gateway: BorrowGateway = {
  rest: async (_method, path) => {
    const route = path.split("?")[0]
    const answer =
      route === "/v1/borrow/grants" ? { grants: [grant] }
      : route === "/v1/borrow/leases" ? { leases: [] }
      : route === "/v1/borrow/events" ? { events: [] }
      : route === "/v1/borrow/asks" ? { asks: [sourceAsk] }
      : undefined
    return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer))
  },
}
const source = webSetup(gateway, "acct", () => [{ id: MAC, name: "MacBook Pro", platform: "macOS 26.1" }], () => NOW)

// 1. A laptop's browser: Settings is given a way to open a project's Setup, which draws in its pane at the desk's form.
const opened: ScreenRoute[] = []
const settings = DeskSettings({ route: { kind: "settings" }, open: (next) => opened.push(next) })
assert.equal(settings.type, Settings, "the pane holds Settings")
assert.ok(settings.props.onSetup, "and Settings offers each project's Setup")
settings.props.onSetup("shop")
assert.deepEqual(opened, [{ kind: "setup", project: "shop" }])
const pane = DeskSettings({ route: { kind: "setup", project: "shop" }, open: (next) => opened.push(next) })
assert.equal(pane.type, SetupScreen, "the pane draws the project's Setup")
assert.equal(pane.props.desk, true, "at the desk's form")
pane.props.onBack()
assert.deepEqual(opened.at(-1), { kind: "settings" }, "and goes back to Settings")
setSetupSource(source)
await readSetup("shop")
assert.match(renderToStaticMarkup(<SetupPage folder="shop" />), /data-setup-page=/, "the desk's form draws on the account broker's source")

// 2. On a page built away from the Mac, what only the Mac can do isn't offered.
const page = setupStore.get().byFolder.shop!
assert.equal(page.away, true)
const cloud = "cloud"
setupStore.set((state) => ({ place: { ...state.place, shop: cloud } }))
const phone = renderToStaticMarkup(<PhoneSetup folder="shop" />)
assert.match(phone, /Allow it on your Mac/, "the ask says where it can be allowed")
assert.deepEqual([...phone.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).filter((label) => /Allow|For this Thread|Project|Decline/.test(label!)), ["Decline"], "and Decline is the one answer")
const desk = renderToStaticMarkup(<SetupPage folder="shop" />)
assert.doesNotMatch(desk, /data-setup-add|Rebuild base/, "nothing to Add or rebuild from here")
for (const action of ["send", "add", "retry", "keep"]) assert.doesNotMatch(desk, new RegExp(`data-setup-action="${action}"`), `no ${action}`)
const pending = { ...page.places[0]!.parts[0]!.rows[0]!, action: "send" as const }
assert.equal(rowAction(pending, NOW), "send", "on a Mac's own page a row keeps its button")
assert.equal(rowAction(pending, NOW, true), undefined, "away from it, only Stop stays")

// 3. It says what it is: what the account lends, not that a device has nothing.
assert.match(phone, /This shows what your account lends\. Open Setup on your Mac for the rest\./)
assert.doesNotMatch(phone, /Nothing yet/, "an empty part says no grants, not nothing")
assert.match(phone, /No grants/)
assert.equal(partSummary({ part: "code", rows: [] }, NOW, true).line, "No grants")
assert.equal(partSummary({ part: "code", rows: [] }, NOW).line, "Nothing yet", "a Mac's own page still says Nothing yet")

// 4. An ask a project's two folders hold is one ask, in the Inbox and to answer.
setSetupSource(undefined)
const { away: _away, ...withAsk } = page
const reads: string[] = []
let answered = false
setSetupSource({
  read: async (folder): Promise<SetupView> => {
    reads.push(folder)
    return answered ? { ...withAsk, places: withAsk.places.map((place) => ({ ...place, asks: [] })) } : withAsk
  },
  act: async () => {
    answered = true
    return { done: true }
  },
})
await readSetup("/Users/you/shop")
await readSetup("/Users/you/.worktrees/shop-1")
setupStore.set((state) => {
  const byFolder = { ...state.byFolder }
  delete byFolder.shop
  return { byFolder }
})
assert.equal(allAsks(setupStore.get()).length, 1, "the two folders' views list it once")
assert.equal(inboxModel().asks.filter((item) => item.kind === "setup").length, 1, "and the Inbox's row")
assert.equal(inboxCount(inboxModel()), 1, "and its badge")
reads.length = 0
const [listed] = allAsks(setupStore.get())
answerAsk(listed!.folder, listed!.ask, "allow-thread")
await new Promise((done) => setTimeout(done, 10))
assert.deepEqual([...reads].sort(), ["/Users/you/.worktrees/shop-1", "/Users/you/shop"], "answering it reads every folder holding it")
assert.equal(allAsks(setupStore.get()).length, 0, "so no twin stands")
setSetupSource(undefined)
console.log("Setup away from the Mac: Settings and the pane in a laptop's browser, only what the source can do, says what it sees, one ask however many folders hold it")
