import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { Prose } from "../src/components/transcript/markdown"
import { threadToken } from "../src/lib/mentions"
import {
  parseThreadReferenceAppendix,
  restoreThreadReferences,
} from "../src/lib/thread-references"
import { threadsStore } from "../src/state/threads"
import type { ThreadRef } from "../src/lib/types"

/**
 * A referenced conversation goes out as "[Referenced conversation N]" with a
 * heading in the appendix, and comes back in the transcript as the chip it
 * was typed as. These checks render the production prose with the text a
 * send writes and assert the chip, without a host.
 */

// SAFETY: this renderer fixture supplies every ThreadRef field read by token resolution and chip rendering; unrelated catalog metadata is deliberately absent.
const referenced = {
  path: "/cursor/agents/abc/store.db",
  harness: "cursor",
  nativeId: "9a8d2fbd-58be-4e11-841b-00f294b98f71",
  title: "For Mako Local Control MCP and even the browser use",
  cwd: "/repo",
  updatedAt: "2026-09-16T08:00:00.000Z",
} as ThreadRef
threadsStore.set({ threads: [referenced] })
const token = threadToken(referenced.harness, referenced.nativeId)

/* The current format: the heading carries the token ----------------------- */

const sent = [
  "I thought [Referenced conversation 1] fixed this?",
  "",
  "---",
  `[Referenced conversation 1] ${referenced.title} (cursor) — ${token}`,
  "",
  "Local transcript bundle: /Users/you/.mako/transcripts/865c90e6/transcript.md",
  "",
  "Before using this reference, read transcript.md at that exact content-addressed path in full.",
].join("\n")
const parsed = parseThreadReferenceAppendix(sent)
const text = restoreThreadReferences(parsed.body, parsed.references)
assert.equal(text, `I thought ${token} fixed this?`)
const titled = parsed.references.filter((entry) => !entry.token)
assert.equal(titled.length, 0)
const prose = renderToStaticMarkup(<Prose text={text} references={[]} threads={titled} />)
assert.match(prose, /data-copy-reference="@thread:cursor:9a8d2fbd/, "the chip copies as the token")
assert.match(prose, />For Mako Local Control MCP and even the browser use</, "and shows the catalog's title")
assert.doesNotMatch(prose, /Referenced conversation/, "the placeholder never reaches the screen")
assert.doesNotMatch(prose, /transcript bundle/, "nor does the appendix")
assert.match(prose, / fixed this\?/, "sentence punctuation after the chip stays prose")

/* A prompt sent before headings carried tokens ----------------------------- */

const legacySent = [
  "Compare [Referenced conversation 1] with [Referenced conversation 2].",
  "",
  "---",
  "[Referenced conversation 1] Older thread (claude)",
  "",
  "Local transcript bundle: /tmp/a/transcript.md",
  "",
  "[Referenced conversation 2] Untitled conversation",
  "",
  "This referenced conversation is unavailable or no longer exists. Do not infer its contents.",
].join("\n")
const legacy = parseThreadReferenceAppendix(legacySent)
const legacyText = restoreThreadReferences(legacy.body, legacy.references)
assert.equal(legacyText, legacy.body, "nothing to restore")
const legacyTitled = legacy.references.filter((entry) => !entry.token)
assert.equal(legacyTitled.length, 2)
const legacyProse = renderToStaticMarkup(<Prose text={legacyText} references={[]} threads={legacyTitled} />)
assert.match(legacyProse, />Older thread</, "the heading's title is the chip")
assert.match(legacyProse, />Untitled conversation</, "an unavailable reference still reads as a chip")
assert.doesNotMatch(legacyProse, /Referenced conversation/, "the placeholder never reaches the screen")
assert.doesNotMatch(legacyProse, /data-copy-reference="@thread/, "a chip without a token copies as its text")
assert.match(legacyProse, /Compare <span/, "the words around the chips stay")
assert.match(legacyProse, /<\/span> with <span/, "in order")

/* A placeholder nobody wrote ----------------------------------------------- */

const plain = renderToStaticMarkup(<Prose text="Literally [Referenced conversation 9]" references={[]} threads={[]} />)
assert.match(plain, /\[Referenced conversation 9\]/, "text that only looks like a placeholder is left alone")

console.log("thread reference ui ok")
