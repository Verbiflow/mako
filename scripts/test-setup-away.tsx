/**
 * Setup away from the Mac, rendered: a laptop's browser reaches a project's Setup from Settings in its pane, and a page
 * built from the account broker alone draws only what it can do and says only what it can see. Every ask is listed
 * once however many folders hold it, and answering it clears it from all of them.
 */
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import type { Grant, LeaseEvent, SourceAsk } from "@mako/protocol/borrow"
import { partSummary, rowAction, type SetupAsk, type SetupView } from "@mako/host/contracts/setup"
import { PhoneSetup, SetupPage, ThreadSetup } from "@/components/setup/setup-page"
import { AskRow } from "@/components/setup/setup-parts"
import { ZodError } from "zod"
import { allAsks, readFailure, readSetup, setSetupDrafter, setSetupSource, setupAskCard, setupDrafter, setupStore } from "@/state/setup"
import { ASK_TOUCH, askNotice, runChoice } from "@/lib/ask-card"
import { inboxCount, inboxModel } from "@/state/inbox"
import DeskSettings from "@/web-client/desk-settings"
import { closeSetup, openSetup, setupOpenStore } from "@/web-client/setup-open"
import { SetupRailRow } from "@/web-client/setup-rail-row"
import type { ScreenRoute } from "@/web-client/route"
import { Settings } from "@/web-client/settings"
import { SetupScreen } from "@/web-client/setup-screen"
import { listedAsker, webSetup, type BorrowGateway } from "@/web-client/setup-source"

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
// The broker's log says when the ask was made: its age is that, not the read's.
const ASKED_AT = NOW - 12 * 60_000
const askedEvent: LeaseEvent = { event: "asked", at: ASKED_AT, grant: "g-env", borrower: sourceAsk.borrower, resource: { kind: "file", ref: ".env.local" }, correlationId: "c-ask-1" }
const gateway: BorrowGateway = {
  rest: async (_method, path) => {
    const route = path.split("?")[0]
    const answer =
      route === "/v1/borrow/grants" ? { grants: [grant] }
      : route === "/v1/borrow/leases" ? { leases: [] }
      : route === "/v1/borrow/events" ? { events: [askedEvent] }
      : route === "/v1/borrow/asks" ? { asks: [sourceAsk] }
      : undefined
    return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer))
  },
}
const source = webSetup(gateway, "acct", () => [{ id: MAC, name: "MacBook Pro", platform: "macOS 26.1" }], () => NOW, (thread) => listedAsker([{ thread: "t-1", title: "Fix the webhooks", harness: "codex" }], thread))

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

// The laptop's right rail has a Setup row, which opens Setup's layer.
assert.match(renderToStaticMarkup(<SetupRailRow open={false} conversation="c-1" />), /data-surface-id="setup"/, "the laptop browser's rail has a Setup row")
openSetup()
assert.equal(setupOpenStore.get().open, true)
closeSetup()

// "Add to setup" drafts the request in a new Thread of the project: it has landed only once a Thread opened and its
// composer took the words. A Thread that can't open, or words nobody took, leave the ask open to answer again.
{
  Reflect.set(globalThis, "window", Object.assign(new EventTarget(), { requestAnimationFrame: (run: () => void) => setTimeout(run, 0) }))
  const toolAsk: SetupAsk = { id: "ask-tool", kind: "tool", tool: "terraform", version: "1.9", by: { thread: "t-1", title: "Fix the webhooks", fin: false }, at: NOW, why: "provision the database", place: "cloud" }
  setupStore.set((state) => ({ byFolder: { ...state.byFolder, tools: { project: "tools", root: "/Users/you/tools", repository: null, places: [], at: NOW } } }))
  const addToSetup = () => setupAskCard("tools", toolAsk, false).choices.find((choice) => choice.answer === "add-to-setup")!
  let opened = 0
  const composed: string[] = []
  const draft = (open: boolean, take: boolean) => setupDrafter(async () => (opened++, open), async (text) => { if (take) composed.push(text); return take })
  const steps: boolean[] = []
  setSetupDrafter(draft(false, true))
  assert.equal(await runChoice(addToSetup(), (busy) => steps.push(busy)), false, "a new Thread that couldn't open drafted nothing")
  assert.deepEqual([opened, composed.length, steps], [1, 0, [true, false]], "so the ask's buttons come back")
  steps.length = 0
  setSetupDrafter(draft(true, false))
  assert.equal(await runChoice(addToSetup(), (busy) => steps.push(busy)), false, "words no composer took aren't a draft")
  assert.deepEqual(steps, [true, false])
  steps.length = 0
  setSetupDrafter(draft(true, true))
  assert.equal(await runChoice(addToSetup(), (busy) => steps.push(busy)), true, "a Thread opened with the request written")
  assert.deepEqual([composed.length, steps], [1, [true]])
  assert.match(composed[0]!, /^Add terraform 1\.9 to this project's recipe prepare/)
  setSetupDrafter(undefined)
  Reflect.deleteProperty(globalThis, "window")
}

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

// The ask is the card every surface draws an ask with: the same answers in the composer's notice and the Inbox.
const [held] = allAsks(setupStore.get())
const card = setupAskCard("shop", held!.ask, true)
assert.deepEqual([card.note, card.choices.map((choice) => [choice.answer, Boolean(choice.primary)])], ["Allow it on your Mac", [["decline", false]]], "away, the card says where to allow it and offers only no")
const notice = askNotice("setup-ask", card)
assert.deepEqual([notice.tone, notice.actions?.map((action) => action.label)], ["attention", ["Decline"]])
assert.match(notice.description ?? "", /Allow it on your Mac/)
const atMac = setupAskCard("shop", held!.ask, false)
assert.equal(atMac.choices[0]?.primary, true, "on the Mac the narrowest yes is the one to take")

// 3. It says what it is: what the account lends, not that a device has nothing.
assert.match(phone, /This shows what your account lends\. Open Setup on your Mac for the rest\./)
assert.doesNotMatch(phone, /Nothing yet/, "an empty part says no grants, not nothing")
assert.match(phone, /No grants/)
assert.equal(partSummary({ part: "code", rows: [] }, NOW, true).line, "No grants")
assert.equal(partSummary({ part: "code", rows: [] }, NOW).line, "Nothing yet", "a Mac's own page still says Nothing yet")

// Every surface that lists its grants says what it can't see, in the one line: Settings › Setup, the laptop browser's
// rail and the phone. A Mac's own page says nothing of the kind.
const awayNotes = (html: string) => html.split("data-setup-away-note").length - 1
assert.equal(awayNotes(renderToStaticMarkup(<SetupPage folder="shop" />)), 1, "Settings › Setup, and the laptop browser's page")
assert.equal(awayNotes(renderToStaticMarkup(<PhoneSetup folder="shop" />)), 1, "the phone")
assert.equal(awayNotes(renderToStaticMarkup(<ThreadSetup folder="shop" thread="t-1" elsewhere="a cloud machine" />)), 1, "the laptop browser's rail")
assert.match(renderToStaticMarkup(<SetupPage folder="shop" />), /What each place has for shop/, "and the page names its project")

// The phone names the asking Thread as the account lists it, aged from when it asked.
const asked = setupStore.get().byFolder.shop!.places.flatMap((place) => place.asks)[0]!
assert.deepEqual([asked.by.title, asked.by.harness, asked.at], ["Fix the webhooks", "codex", ASKED_AT])
assert.match(phone, /Fix the webhooks/)
assert.match(phone, /12m/)

// Its answers are as tall as the card's under a finger.
assert.ok(phone.includes(ASK_TOUCH), "the phone's Decline takes the card's touch height")

// A long asking title gives way; what's asked for is said whole, on its own line, on every card and in the notice.
const longTitle = "I'll read the MetaHarness track plan and the phone composer notes, then fix the webhook retries"
const longAsk = { ...asked, by: { ...asked.by, title: longTitle } }
const row = renderToStaticMarkup(<AskRow folder="shop" ask={longAsk} now={NOW} compact />)
assert.match(row, /data-ask-want[^>]*>Wants a copy of <span[^>]*>\.env\.local<\/span>/, "the want, whole")
assert.match(row, new RegExp(`data-ask-who[^>]*><span class="min-w-0 truncate">${longTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#x27;")}</span>`), "the name, which gives way")
assert.equal(askNotice("setup-ask", setupAskCard("shop", longAsk, false)).title, "Wants a copy of .env.local", "the notice's line is the want")

// A read that fails says why in words and offers Try again; a reply this build can't read isn't printed.
assert.equal(readFailure(new ZodError([])), "Its answer wasn't one this version of Mako reads.")
setupStore.set((state) => ({ failed: { ...state.failed, gone: "The account didn't answer." } }))
const failedPhone = renderToStaticMarkup(<PhoneSetup folder="gone" />)
assert.match(failedPhone, /data-setup-failed/)
assert.match(failedPhone, /Setup couldn(&#x27;|')t be read\. The account didn(&#x27;|')t answer\./)
assert.match(failedPhone, /Try again/)
assert.ok(failedPhone.split("Try again")[0]!.includes(ASK_TOUCH), "Try again is as tall as the answers under a finger")
for (const surface of [<SetupPage folder="gone" />, <ThreadSetup folder="gone" thread="t-1" elsewhere={undefined} />]) assert.match(renderToStaticMarkup(surface), /Try again/)

// 4. An ask a project's two folders hold is one ask, in the Inbox and to answer.
setSetupSource(undefined)
const { away: _away, ...withAsk } = page
const reads: string[] = []
let answered = false
let refusing = true
setSetupSource({
  read: async (folder): Promise<SetupView> => {
    reads.push(folder)
    return answered ? { ...withAsk, places: withAsk.places.map((place) => ({ ...place, asks: [] })) } : withAsk
  },
  act: async () => {
    if (refusing) return { done: false, why: "The source said no." }
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
// An answer that doesn't land frees its buttons and leaves the ask open; one that lands holds them until it goes.
const [listed] = allAsks(setupStore.get())
const choice = setupAskCard(listed!.folder, listed!.ask, false).choices[0]!
const steps: boolean[] = []
assert.equal(await runChoice(choice, (busy) => steps.push(busy)), false, "the source refused it")
assert.deepEqual(steps, [true, false], "so its buttons are free again")
await new Promise((done) => setTimeout(done, 10))
assert.equal(allAsks(setupStore.get()).length, 1, "and the ask is still open to answer")
const failing: boolean[] = []
assert.equal(await runChoice({ ...choice, choose: () => Promise.reject(new Error("the host is gone")) }, (busy) => failing.push(busy)), false, "an answer that throws hasn't landed")
assert.deepEqual(failing, [true, false])
refusing = false
reads.length = 0
steps.length = 0
assert.equal(await runChoice(choice, (busy) => steps.push(busy)), true, "the source took it")
assert.deepEqual(steps, [true], "held until the ask goes")
await new Promise((done) => setTimeout(done, 10))
assert.deepEqual([...reads].sort(), ["/Users/you/.worktrees/shop-1", "/Users/you/shop"], "answering it reads every folder holding it")
assert.equal(allAsks(setupStore.get()).length, 0, "so no twin stands")
setSetupSource(undefined)
console.log("Setup away from the Mac: Settings and the pane in a laptop's browser, only what the source can do, says what it sees, one ask however many folders hold it")
