/**
 * The Inbox's one count: the page's "N need you" and the rail's Inbox count are `inboxCount`, which takes the Inbox's
 * asks and the Apex plan lines waiting on the person, the two lists the page shows under Needs you. A plan's to-do
 * once went uncounted in the rail while the page listed it, so the page said 6 and the rail 4.
 */
import assert from "node:assert/strict"
import type { ApexEntry } from "@mako/host/contracts/apexes"
import { planAsksOf } from "@/state/apexes"
import { inboxCount, type InboxAsk, type InboxModel } from "@/state/inbox"

const apex: ApexEntry = { thread: "0b9c7f1e-4a3d-4c55-9a51-7d2f3e8c1a20", name: "Mobile polish", handle: "mobile-polish", createdAt: 0, from: "new", by: "person" }
const plan = `# Mobile polish

## Now

- [ ] fin:sheet sheet motion on iPad

## Waiting on you

- [ ] Merge the phone case once it's green
- [x] Pick the icon
- [ ] Which group gets the 0.9 build? [Internal | Beta testers]

## Blocked
`

const waiting = (key: string): InboxAsk => ({ kind: "waiting", key, title: key, harness: "codex", question: "Waiting for you", since: 0, open: { kind: "conversation", key } })
const model: InboxModel = { asks: [waiting("a"), waiting("b"), waiting("c"), waiting("d")], toRead: [] }

const plans = planAsksOf([apex], { [apex.thread]: plan })
assert.deepEqual(
  plans.map((ask) => ask.text),
  ["Merge the phone case once it's green", "Which group gets the 0.9 build? [Internal | Beta testers]"],
  "the plan's open lines under Waiting on you, its done line left out"
)
assert.equal(inboxCount(model, plans), 6, "four asks and two plan lines need the person, on the page and in the rail")
assert.equal(inboxCount(model, []), 4, "an Apex whose plan isn't read yet adds nothing")
assert.equal(inboxCount({ asks: [], toRead: [] }, plans), 2, "plan lines alone still count")
assert.equal(planAsksOf([apex], {}).length, 0, "no plan, no lines")

console.log("PASS: the Inbox's count is its asks and the Apex plan lines waiting on the person")
