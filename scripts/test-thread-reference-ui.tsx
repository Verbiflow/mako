import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { Prose } from "../src/components/transcript/markdown"
import { hasThreadToken, threadToken, toggleThreadToken } from "../src/lib/mentions"
import { readSent } from "../src/lib/context/sent"
import { sentDraft, writeDraft } from "../src/lib/context/draft"
import { threadsStore } from "../src/state/threads"
import { ReferenceOverlay } from "../src/components/composer/reference-overlay"
import { draftView, editDraftView, spanInside, threadLabel, toDraftOffset, toViewOffset } from "../src/lib/draft-view"
import { threadLabelKey, threadLabelMap } from "../src/lib/thread-references"
import type { ThreadRef } from "../src/lib/types"

/**
 * A referenced conversation goes out as a marker and an item, and comes back
 * in the transcript as the chip it was typed as. These checks render the
 * production prose with what a send writes, and an older prompt's appendix,
 * and assert the chip, without a host.
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
const render = (raw: string) => {
  const read = readSent(raw)
  return renderToStaticMarkup(<Prose text={read.body} sent={{ items: read.items, records: new Map() }} />)
}

/* What a send writes ---------------------------------------------------------- */

const sent = writeDraft({
  draft: `I thought ${token} fixed this?`,
  records: [],
  conversations: new Map([[token, { ref: token.slice(1), thread: referenced, context: { kind: "file", file: "/Users/you/.mako/transcripts/865c90e6/transcript.md", note: "<mako_transcript>\nThis conversation's history (Cursor, 3 turns) is in /Users/you/.mako/transcripts/865c90e6/transcript.md.\n</mako_transcript>", title: referenced.title, harness: "cursor" } }]]),
}).text
assert.equal(sentDraft(readSent(sent)).text, `I thought ${token} fixed this?`, "Reuse puts the token back")
const prose = render(sent)
assert.match(prose, /data-copy-reference="@thread:cursor:9a8d2fbd/, "the chip copies as the token")
assert.match(prose, />For Mako Local Control MCP and even the browser use</, "and shows the catalog's title")
assert.doesNotMatch(prose, /Conversation 1/, "the marker never reaches the screen")
assert.doesNotMatch(prose, /transcript bundle|mako_context/i, "nor does the item")
assert.match(prose, / fixed this\?/, "sentence punctuation after the chip stays prose")

/* A prompt from before the format ------------------------------------------- */

const oldSent = [
  "I thought [Referenced conversation 1] fixed this?",
  "",
  "---",
  `[Referenced conversation 1] ${referenced.title} (cursor) — ${token}`,
  "",
  "Local transcript bundle: /Users/you/.mako/transcripts/865c90e6/transcript.md",
].join("\n")
const oldProse = render(oldSent)
assert.match(oldProse, /data-copy-reference="@thread:cursor:9a8d2fbd/, "an older prompt's heading token draws the same chip")
assert.doesNotMatch(oldProse, /Referenced conversation/)

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
const legacyProse = render(legacySent)
assert.match(legacyProse, />Older thread</, "the heading's title is the chip")
assert.match(legacyProse, />Untitled conversation</, "an unavailable reference still reads as a chip")
assert.doesNotMatch(legacyProse, /Referenced conversation/, "the placeholder never reaches the screen")
assert.doesNotMatch(legacyProse, /data-copy-reference="@thread/, "a chip without a token copies as its text")
assert.match(legacyProse, /Compare <span/, "the words around the chips stay")
assert.match(legacyProse, /<\/span> with <span/, "in order")

/* A marker nobody wrote ------------------------------------------------------ */

const plain = render("Literally [Referenced conversation 9] and [Conversation 9: x]")
assert.match(plain, /\[Referenced conversation 9\] and \[Conversation 9: x\]/, "text that only looks like a marker is left alone")

/* A new tab's transcript chips add and remove the token --------------------- */

const added = toggleThreadToken("Pick up where", referenced.harness, referenced.nativeId)
assert.equal(added, `Pick up where ${token} `, "a chip adds the token at the end, spaced")
assert.ok(hasThreadToken(added, referenced.harness, referenced.nativeId))
assert.equal(toggleThreadToken(added, referenced.harness, referenced.nativeId), "Pick up where ", "and takes it out again with its space")
const other = threadToken(referenced.harness, `${referenced.nativeId}0`)
assert.equal(hasThreadToken(`${other} `, referenced.harness, referenced.nativeId), false, "a longer id with the same start is another conversation")
assert.equal(toggleThreadToken(`${token} then ${token} and ${other}`, referenced.harness, referenced.nativeId), `then and ${other}`, "every copy of the token goes, and only that one")

/* The composer shows a conversation as its label ---------------------------- */

const labels = threadLabelMap(threadLabelKey(`see ${token}`, [referenced]))
const label = threadLabel(referenced.title)
assert.equal(label, "@For Mako Local Control MCP and even the browser…", "a long title is cut to the label's length")
assert.equal(threadLabel("  two\nlines  "), "@two lines", "a label is one line")
assert.equal(threadLabel(undefined), "@Untitled conversation")
assert.equal(threadLabelKey(`${threadToken("cursor", "nobody")} `, [referenced]), "", "a token naming nothing has no label")
assert.equal(threadLabelMap(threadLabelKey(`${threadToken("cursor", "nobody")} `, [], false)).get(threadToken("cursor", "nobody")), "@Conversation", "before the catalog loads, a conversation is a chip without its title")

const draft = `see ${token} and fix it`
const view = draftView(draft, labels)
assert.equal(view.text, `see ${label} and fix it`, "the textarea holds the label, not the token")
const [span] = view.spans
assert.ok(span)
assert.equal(toDraftOffset(view, view.text.length), draft.length, "the end maps to the end")
assert.equal(toViewOffset(view, draft.length), view.text.length)
assert.equal(toDraftOffset(view, span.viewEnd), span.draftEnd, "a label's edges are the token's")
assert.equal(toViewOffset(view, span.draftStart + 5), span.viewEnd, "inside a token lands on the label's end")
assert.equal(toDraftOffset(view, span.viewStart + 3, true), span.draftStart, "or its start")
assert.equal(spanInside(view, span.viewStart), undefined, "an edge isn't inside")
assert.ok(spanInside(view, span.viewStart + 1))

const typed = (next: string, caret: number) => editDraftView(draft, view, next, caret)
const after = view.text.slice(0, span.viewEnd) + "!" + view.text.slice(span.viewEnd)
assert.deepEqual(typed(after, span.viewEnd + 1), { draft: `see ${token}! and fix it`, caret: span.draftEnd + 1 }, "typing after a label types after the token")
const doubled = view.text.slice(0, view.text.length - 1) + "tt"
assert.equal(typed(doubled, view.text.length).draft, `${draft}t`, "a repeated letter is placed at the caret")
const backspaced = view.text.slice(0, span.viewEnd - 1) + view.text.slice(span.viewEnd)
assert.deepEqual(typed(backspaced, span.viewEnd - 1), { draft: "see  and fix it", caret: 4 }, "deleting into a label removes the conversation, not one character of its id")
const inside = view.text.slice(0, span.viewStart + 4) + "x" + view.text.slice(span.viewStart + 4)
assert.equal(typed(inside, span.viewStart + 5).draft, "see x and fix it", "typing inside a label replaces the conversation")
const selected = view.text.slice(0, 2) + view.text.slice(span.viewStart + 3)
assert.equal(typed(selected, 2).draft, "se and fix it", "a selection reaching into a label takes all of it")
assert.equal(typed(view.text.replace("fix", "mend"), view.text.indexOf("fix") + 4).draft, `see ${token} and mend it`, "prose edits leave the token alone")
const replacedAll = editDraftView("/", draftView("/", new Map()), "please run /", 12, { start: 0, end: 1 })
assert.deepEqual(replacedAll, { draft: "please run /", caret: 12 }, "the caret is where the textarea put it, even when a replacement keeps a character")
const beforeChip = editDraftView(draft, view, "x" + view.text, 1)
assert.equal(beforeChip.caret, 1, "typing before a chip leaves the caret before it")
const afterWords = editDraftView(draft, view, view.text + "!", view.text.length + 1)
assert.equal(afterWords.caret, afterWords.draft.length, "and at the end it ends there")
assert.equal(
  editDraftView(draft, view, "see @For", 8, { start: 0, end: view.text.length }).draft,
  "see @For",
  "replacing everything with text that begins like the label keeps every typed character"
)
assert.equal(
  editDraftView(draft, view, "see @For", 8).draft,
  "see  and fix it".slice(0, 4),
  "without the selection the same text reads as an edit inside the label"
)
assert.equal(
  editDraftView(draft, view, `${view.text}and more`, view.text.length + 8, { start: 0, end: view.text.length }).draft,
  `${draft}and more`,
  "a replacement that keeps a label's characters keeps the conversation"
)
const partly = view.text.slice(0, span.viewStart + 3) + view.text.slice(span.viewStart + 9)
assert.equal(
  editDraftView(draft, view, partly, span.viewStart + 3, { start: span.viewStart + 3, end: span.viewStart + 9 }).draft,
  "see  and fix it",
  "deleting a selection inside a label removes the conversation"
)
const over = view.text.slice(0, span.viewStart + 3) + "zz" + view.text.slice(span.viewStart + 9)
assert.equal(
  editDraftView(draft, view, over, span.viewStart + 5, { start: span.viewStart + 3, end: span.viewStart + 9 }).draft,
  "see zz and fix it",
  "typing over part of a label replaces the conversation with what was typed"
)

const painted = renderToStaticMarkup(<ReferenceOverlay text={draft} attachments={[]} labels={labels} />)
// The agent's mark is positioned over the transparent "@", so it takes no width.
const mark = /<(svg|span) class="[^"]*absolute top-1\/2 left-0[^"]*"[^>]*>[\s\S]*?<\/\1>/
assert.match(painted, mark, "the agent's mark sits over the @")
const glyphs = painted.replace(mark, "").replace(/<[^>]+>/g, "")
assert.equal(glyphs.replaceAll("&amp;", "&"), view.text, "the painted layer draws exactly the textarea's characters")
assert.doesNotMatch(painted, /thread:cursor/, "no hidden token takes width")
const unresolved = renderToStaticMarkup(<ReferenceOverlay text={`a ${threadToken("cursor", "nobody")}`} attachments={[]} labels={new Map()} />)
assert.match(unresolved, /thread:cursor:nobody/, "a token naming nothing stays as typed")

console.log("thread reference ui ok")
