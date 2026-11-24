import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { FinSharingLine } from "@/components/inspector/fin-sharing-line"

/** A Fin's sharing line (`npm run test:fin-collisions`): the host's words on its row, and only for a Fin that shares a file. */

function fin(sharing?: string): NativeAgent {
  return { nativeId: "fin", title: "Tests", work: "agent", state: { kind: "working" }, bindingId: "children", provider: "codex", observedAt: 0, child: { thread: "11111111-1111-4111-8111-111111111111", name: "tests", origin: "started", state: { kind: "working" }, ...(sharing && { sharing }) } }
}

const shown = renderToStaticMarkup(<FinSharingLine agent={fin("Also editing agents.ts with docs")} />)
assert.match(shown, /data-fin-sharing/)
assert.match(shown, /Also editing agents\.ts with docs/)
assert.match(shown, /text-muted-foreground/, "in the row's own muted line")
assert.doesNotMatch(shown, /<svg/, "words alone")
assert.equal(renderToStaticMarkup(<FinSharingLine agent={fin()} />), "")
console.log("fin sharing line: the host's words, only for a Fin that shares a file")
