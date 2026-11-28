/**
 * The phone's Inbox counts as the desk's does: its Fins, its waiting Threads and the lines of an Apex's plan waiting on
 * the person, the same lines the desk reads (`planAsksOf`). The list's Inbox chip and the Inbox page's "N need you"
 * are both `webInboxCount`; the chip once left plan lines out, so the phone's chip said 1 while its page and the desk
 * said 3.
 */
import assert from "node:assert/strict"
import type { ApexEntry } from "@mako/host/contracts/apexes"
import { planAsksOf } from "@/state/apexes"
import { webPlanAsks, type ListedWebApex } from "@/web-client/apexes"
import { webInboxCount } from "@/web-client/inbox"
import type { WebThread } from "@/web-client/threads"

const apex: ApexEntry & { deviceId: string } = { thread: "0b9c7f1e-4a3d-4c55-9a51-7d2f3e8c1a20", name: "Mobile polish", handle: "mobile-polish", createdAt: 0, from: "new", by: "person", deviceId: "mac" }
const plan = `# Mobile polish

## Now

- [ ] fin:sheet sheet motion on iPad

## Waiting on you

- [ ] Merge the phone case once it's green
- [x] Pick the icon
- [ ] Which group gets the 0.9 build? [Internal | Beta testers]
`

const waiting: WebThread = { id: "c5f0a7d2-1b3e-4f6a-8c9d-0e1f2a3b4c5d", title: "Phone case", sessions: [], standing: "waiting", where: "mac", activityAt: 0, waitingMessages: 0 }

const read = { plans: { [apex.thread]: plan }, plansAt: {}, listed: {} }
const plans = webPlanAsks([apex], read)
assert.deepEqual(plans, planAsksOf([apex], { [apex.thread]: plan }), "the phone reads an Apex's waiting lines as the desk does")
assert.deepEqual(plans.map((ask) => ask.text), ["Merge the phone case once it's green", "Which group gets the 0.9 build? [Internal | Beta testers]"])
assert.equal(plans[0]!.apex.deviceId, "mac", "each line keeps the Mac its Apex is on, to check it off there")

assert.equal(webInboxCount([waiting], [], [], plans), 3, "a waiting Thread and two plan lines need the person, in the chip and on the page")
assert.equal(webInboxCount([waiting], [], [], []), 1, "an Apex whose plan isn't read yet adds nothing")
assert.equal(webInboxCount([], [], [], plans), 2, "plan lines alone still count")

const listed: ListedWebApex = { name: apex.name, plan, at: 1, deviceId: "mac", thread: apex.thread, conversation: "c", harness: "codex", createdAt: 0, quietSince: "2026-11-28T00:00:00Z" }
assert.equal(webPlanAsks([apex], { ...read, listed: { [apex.thread]: listed } }).length, 0, "a quiet owner's to-dos wait in its digest, not the Inbox")

console.log("web inbox count: ok")
