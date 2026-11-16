// The person's waiting line (`turn-wait-line.tsx`): its words with the time a wait runs to, each item ticked off as
// it's met, and Stop waiting its only action. Drawn through the production component.
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { WaitLine } from "../src/components/viewer/turn-wait-line"
import { waitLineWords, waitUntilWords } from "../src/state/turn-wait-line"
import type { TurnWaitLine } from "@mako/host/contracts/turn-waits"

const zone = "America/Los_Angeles"
// Mon 2026-11-16 10:00 in Los Angeles.
const now = Date.parse("2026-11-16T18:00:00Z")
assert.equal(waitUntilWords(Date.parse("2026-11-16T23:30:00Z"), now, "en-US", zone), "until 3:30 PM", "today: the time alone")
assert.equal(waitUntilWords(Date.parse("2026-11-17T17:00:00Z"), now, "en-US", zone), "until Tue 9:00 AM", "within the week: its weekday")
assert.equal(waitUntilWords(Date.parse("2026-11-23T17:00:00Z"), now, "en-US", zone), "until Nov 23, 9:00 AM", "beyond: its date")
assert.equal(waitLineWords({ description: "Waiting for CI on #412", endsBy: Date.parse("2026-11-17T17:00:00Z") }, now, "en-US", zone), "Waiting for CI on #412 · until Tue 9:00 AM")
assert.equal(waitLineWords({ description: "Waiting for CI on #412" }, now), "Waiting for CI on #412", "no time, no until")

const line: TurnWaitLine = {
  wait: "w1",
  description: "Waiting for CI on #412",
  items: [{ words: "acme/app#412 checks", met: true }, { words: "fin:docs", met: false }],
  returnWhen: "all",
}
const drawn = renderToStaticMarkup(<WaitLine conversation="c1" line={line} />)
assert.match(drawn, /data-turn-wait-line/)
assert.match(drawn, /Waiting for CI on #412/)
assert.match(drawn, /data-turn-wait-item="met"[^>]*>.*acme\/app#412 checks/, "a met item is ticked off")
assert.match(drawn, /data-turn-wait-item="pending"[^>]*>.*fin:docs/, "one still pending isn't")
assert.match(drawn, /Wakes when all are met/)
assert.equal(drawn.match(/<button/g)?.length, 1, "one action")
assert.match(drawn, /data-turn-wait-stop[^>]*>Stop waiting</, "Stop waiting")
const timeOnly = renderToStaticMarkup(<WaitLine conversation="c1" line={{ wait: "w2", description: "Waiting overnight", items: [], returnWhen: "any", endsBy: now + 3600_000 }} />)
assert.doesNotMatch(timeOnly, /data-turn-wait-item/, "a wait on a time alone lists nothing")
assert.match(timeOnly, /Waiting overnight · until /)
process.stdout.write("turn wait line: words and its time, items ticked off as met, Stop waiting its one action\n")
