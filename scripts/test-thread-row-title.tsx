import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadRow } from "../src/components/rail/thread-row"
import { TooltipProvider } from "../src/components/ui/tooltip"
import type { ThreadRef } from "../src/lib/types"
import { applyThreadTitles } from "../src/state/thread-titles"

/**
 * The rail's row for a Thread: it shows the title Mako generated in place
 * of its Session's own, a person's rename in place of that, and the
 * Session's title again once the Thread has no name.
 */

const THREAD = "7c0a0000-0000-4000-8000-00000000a001"
const ref: ThreadRef = {
  harness: "cursor",
  nativeId: "native-1",
  path: "/tmp/mako-row-title/native-1/store.db",
  cwd: "/tmp/mako-row-title",
  title: "Please take a look at the flaky payments test and…",
  updatedAt: "2026-11-23T10:00:00.000Z",
  threadId: THREAD,
}

const row = () => renderToStaticMarkup(<TooltipProvider><ThreadRow threadRef={ref} /></TooltipProvider>)

assert.match(row(), /Please take a look at the flaky payments test and…/, "a Thread without a name shows its Session's title")

applyThreadTitles([{ thread: THREAD, title: "Fix the flaky payments test", source: "auto" }])
assert.match(row(), /Fix the flaky payments test/, "the row shows the generated title")
assert.doesNotMatch(row(), /Please take a look/, "in place of the prompt's start")

applyThreadTitles([{ thread: THREAD, title: "Payments flake", source: "user" }])
assert.match(row(), /Payments flake/, "a rename replaces it")
assert.doesNotMatch(row(), /Fix the flaky payments test/)

applyThreadTitles([{ thread: THREAD, title: null }])
assert.match(row(), /Please take a look at the flaky payments test and…/, "dropped, the Session's title is back")

console.log("thread row title: a row shows its Session's title, the generated one, a rename over it, and the Session's again once dropped")
