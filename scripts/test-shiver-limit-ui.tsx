import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { LimitNoticeRow } from "../src/components/viewer/limit-notice"
import type { PersonAsk } from "../src/state/fin-asks"

const ask: PersonAsk = { fin: "21111111-1111-4111-8111-111111111111", title: "Usage", harness: "claude",
  question: "2 Fins have nowhere to go.", ask: { kind: "report", id: "limit:fixture", options: [{ label: "Got it" }] },
  limit: { id: "limit:fixture", harness: "claude", line: "2 Fins have nowhere to go.", waiting: { count: 2, at: 1_900_000_000_000, resets: true } } }
const draw = (value: PersonAsk) => renderToStaticMarkup(<LimitNoticeRow apex="fixture" ask={value} compact={false} />)
const held = draw(ask)
assert.match(held, /data-limit-auto="1900000000000"/)
assert.match(held, /Resets at.*The Fins go on by themselves/)
assert.doesNotMatch(held, /<button|Got it|Wait until|Resume/, "pending work is never a dismissal task")
const unknown = draw({ ...ask, limit: { ...ask.limit!, waiting: { ...ask.limit!.waiting!, resets: false } } })
assert.match(unknown, /Next try at.*automatically/)
assert.doesNotMatch(unknown, /Resets at|<button/)
const information = draw({ ...ask, limit: undefined })
assert.match(information, /Got it/)
assert.doesNotMatch(information, /data-limit-auto|go on by themselves/, "prose alone never invents a reset promise")
console.log("PASS: typed reset/retry facts, no dismissal for waiting work, informational legacy notice makes no automatic promise")
