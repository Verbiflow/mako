import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { childGroup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { FinMovedLine } from "@/components/inspector/fin-moved-line"

/** A Fin's moved line (`npm run test:fin-fallback`): whole on a phone, and only when it moved. */

const OUT = "Out of accounts until 3:10 PM PST: personal and work"
const MOVED = "Moved to Claude (work): personal is at its limit until 3:10 PM PST"

function fin(moved: string, state: NonNullable<NativeAgent["child"]>["state"]): NativeAgent {
  return { nativeId: "fin", title: "Labels", work: "agent", state: { kind: "working" }, bindingId: "children", provider: "claude", observedAt: 0, child: { thread: "11111111-1111-4111-8111-111111111111", name: "labels", origin: "started", moved, ...(state && { state }) } }
}

const shown = renderToStaticMarkup(<FinMovedLine agent={fin(MOVED, { kind: "working" })} />)
assert.match(shown, /data-fin-moved/)
assert.match(shown, /Moved to Claude \(work\): personal is at its limit until 3:10 PM PST/)
assert.match(shown, /line-clamp-2/, "a phone reads its reason whole")
assert.doesNotMatch(shown, /truncate/, "and it isn't cut to a line")
// The host says a Fin's stop in its reason and in `moved`: it didn't move, so the row says it once.
assert.equal(renderToStaticMarkup(<FinMovedLine agent={fin(OUT, { kind: "ended", outcome: "stopped", reason: OUT })} />), "")
// A Fin that moved, and later stopped for another reason, still says where it went.
assert.match(renderToStaticMarkup(<FinMovedLine agent={fin(MOVED, { kind: "ended", outcome: "stopped", reason: "the person stopped it" })} />), /data-fin-moved/)
// A Fin out of accounts stopped with its work unfinished: it's never filed as done, nor folded away with what is.
assert.equal(childGroup({ kind: "ended", outcome: "stopped", reason: OUT, unfinished: true }), "failed")
assert.equal(childGroup({ kind: "ended", outcome: "stopped", reason: "the person stopped it" }), "done", "a Stop stays where it was filed")
console.log("fin moved line: on two lines at most, and only for a Fin that moved")
