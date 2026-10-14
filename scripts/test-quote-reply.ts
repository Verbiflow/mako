import assert from "node:assert/strict"
import { QuoteDetailSchema } from "../src/lib/context-detail.ts"
import {
  QUOTE_LABEL_LIMIT,
  QUOTE_LIMIT,
  quoteContext,
  quoteLabel,
  quoteText,
  type QuoteNode,
} from "../src/lib/quote-selection.ts"
import { quoteConversation } from "../src/state/quote-reply.ts"
import type { AcpState, LiveAcpConversation } from "../src/state/acp-state.ts"
import type { ThreadRef } from "../src/lib/types.ts"

/** A node as the DOM gives one: text, or an element with attributes and children. */
class Fake implements QuoteNode {
  readonly childNodes: Fake[]
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly nodeValue: string | null,
    private readonly attributes: Readonly<Record<string, string>>,
    children: Fake[]
  ) {
    this.childNodes = children
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }
}
const text = (value: string) => new Fake(3, "#text", value, {}, [])
const el = (name: string, attributes: Readonly<Record<string, string>>, ...children: Array<Fake | string>) =>
  new Fake(1, name.toUpperCase(), null, attributes, children.map((child) => (child instanceof Fake ? child : text(child))))
const prose = (...children: Array<Fake | string>) => el("div", { class: "mako-prose", "data-answer": "m1" }, "\n", ...children, "\n")

/* ---------- prose ---------- */
const first = text("Restoring a draft on that promise overwrites the paragraph the user has since typed.")
const second = text("Read the result from the preflight instead.")
const paragraphs = prose(el("p", {}, first), "\n", el("p", {}, second))
assert.equal(
  quoteText(paragraphs),
  "Restoring a draft on that promise overwrites the paragraph the user has since typed.\n\nRead the result from the preflight instead.",
  "a whole answer reads as its paragraphs"
)
assert.equal(
  quoteText(paragraphs, { node: first, offset: 10 }, { node: first, offset: 33 }),
  "a draft on that promise",
  "a selection inside one paragraph is the words selected"
)
const styled = prose(el("p", {}, "Keep ", el("strong", {}, "the draft"), " until ", el("code", {}, "send()"), " settles."))
assert.equal(quoteText(styled), "Keep the draft until `send()` settles.", "inline code keeps its backticks; emphasis reads as words")
const lines = prose(el("p", {}, "First line", el("br", {}), "second line"))
assert.equal(quoteText(lines), "First line\nsecond line", "a line break inside a paragraph survives")

/* ---------- lists ---------- */
const third = text("Restore that URL after sign-in.")
const ordered = prose(
  el("ol", {}, "\n", el("li", {}, "Keep the original URL."), "\n", el("li", {}, third), "\n", el("li", {}, "Use the safe redirect check."), "\n")
)
assert.equal(
  quoteText(ordered),
  "1. Keep the original URL.\n2. Restore that URL after sign-in.\n3. Use the safe redirect check.",
  "an ordered list keeps its numbers"
)
assert.equal(
  quoteText(ordered, { node: third, offset: 8 }),
  "2. that URL after sign-in.\n3. Use the safe redirect check.",
  "a selection starting mid-list keeps the numbers the reader saw"
)
const nested = prose(
  el("ul", {}, el("li", {}, "Guard", el("ul", {}, el("li", {}, "keeps returnTo"), el("li", {}, "retries once"))), el("li", {}, "Tests"))
)
assert.equal(quoteText(nested), "- Guard\n  - keeps returnTo\n  - retries once\n- Tests", "nested items indent under their parent")
const started = prose(el("ol", { start: "4" }, el("li", {}, "Four"), el("li", {}, "Five")))
assert.equal(quoteText(started), "4. Four\n5. Five", "a list's start number is kept")

/* ---------- code ---------- */
const codeLine = text("const draft = drafts.get(key)\n")
const codeLast = text("if (!draft) return")
const code = () =>
  el(
    "div",
    { class: "mako-code group", "data-inline-code": "ts" },
    el("div", { class: "mako-code-head" }, el("span", { class: "select-none" }, "ts"), el("button", { "aria-label": "Copy code" }, "Copy")),
    el("div", {}, el("pre", {}, el("code", {}, el("span", { class: "code-line" }, codeLine), el("span", { class: "code-line" }, codeLast))))
  )
const block = prose(code())
assert.equal(
  quoteText(block),
  "```ts\nconst draft = drafts.get(key)\nif (!draft) return\n```",
  "a code block keeps its lines and language, and leaves its header and Copy button out"
)
assert.equal(
  quoteText(block, { node: codeLine, offset: 6 }, { node: codeLast, offset: 10 }),
  "```ts\ndraft = drafts.get(key)\nif (!draft\n```",
  "a selection inside a code block is still fenced, newlines kept"
)
const plain = prose(el("div", { class: "mako-code", "data-inline-code": "text" }, el("div", {}, el("pre", {}, el("code", {}, "a\n\n  b")))))
assert.equal(quoteText(plain), "```\na\n\n  b\n```", "plain text blocks keep blank lines and indentation, with no language")
const fenced = prose(el("div", { "data-inline-code": "md" }, el("pre", {}, el("code", {}, "```js\nx\n```"))))
assert.equal(quoteText(fenced), "````md\n```js\nx\n```\n````", "a block holding a fence gets a longer one")

/* ---------- across blocks ---------- */
const lead = text("The guard keeps the destination, like this:")
const tail = text("Then the refresh retries once before signing out.")
const across = prose(el("p", {}, lead), code(), el("p", {}, tail))
assert.equal(
  quoteText(across, { node: lead, offset: 4 }, { node: tail, offset: 16 }),
  "guard keeps the destination, like this:\n\n```ts\nconst draft = drafts.get(key)\nif (!draft) return\n```\n\nThen the refresh",
  "a selection across paragraphs and a code block reads in order"
)
assert.equal(
  quoteText(across, { node: across, offset: 2 }, { node: across, offset: 3 }),
  "```ts\nconst draft = drafts.get(key)\nif (!draft) return\n```",
  "element boundaries (a triple-click's) select whole children"
)
assert.equal(quoteText(across, { node: lead, offset: 4 }), "guard keeps the destination, like this:\n\n```ts\nconst draft = drafts.get(key)\nif (!draft) return\n```\n\nThen the refresh retries once before signing out.", "an end outside the prose runs to its end")
assert.equal(quoteText(across, undefined, { node: lead, offset: 9 }), "The guard", "a start outside the prose runs from its start")
assert.equal(quoteText(across, { node: tail, offset: 5 }, { node: lead, offset: 3 }), "", "a reversed or empty range quotes nothing")

const withPreview = prose(
  el("p", {}, "See ", el("a", { href: "src/guard.ts" }, "guard.ts"), "."),
  el("div", { "data-inline-file-preview": "src/guard.ts" }, el("pre", {}, "export function guard() {}")),
  el("div", { class: "mako-table" }, el("div", {}, el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Case"), el("th", {}, "Result"))), el("tbody", {}, el("tr", {}, el("td", {}, "Expired"), el("td", {}, "Sign-in"))))), el("button", {}, "Expand table")),
  el("blockquote", {}, el("p", {}, "Never lose a paragraph."))
)
assert.equal(
  quoteText(withPreview),
  "See guard.ts.\n\nCase | Result\nExpired | Sign-in\n\n> Never lose a paragraph.",
  "file previews and table buttons stay out; tables read by row; quotes keep their marker"
)
const headed = prose(el("h2", {}, "Route recovery"), el("p", {}, "Preserve the destination."))
assert.equal(quoteText(headed), "## Route recovery\n\nPreserve the destination.", "headings keep their level")

/* ---------- characters that mean something in markup ---------- */
// A text node holds what the reader sees: `&&`, `<T>` and `a > b` are characters, never entities.
const markupProse = text("Keep it when a > b && b < c, and type it as ")
const markupCode = text("function first<T>(items: T[]): T {\n  return items.length > 0 && items[0] ? items[0] : fallback<T>()\n}")
const markup = prose(
  el("p", {}, markupProse, el("code", {}, "Map<K, V>"), " & \"quotes\"."),
  el("div", { class: "mako-code", "data-inline-code": "ts" }, el("div", {}, el("pre", {}, el("code", {}, markupCode))))
)
const markupText = quoteText(markup)
assert.equal(
  markupText,
  "Keep it when a > b && b < c, and type it as `Map<K, V>` & \"quotes\".\n\n```ts\nfunction first<T>(items: T[]): T {\n  return items.length > 0 && items[0] ? items[0] : fallback<T>()\n}\n```",
  "&&, <T> and a > b read literally in prose and code"
)
const codeValue = markupCode.nodeValue ?? ""
const lineEnd = codeValue.indexOf("\n")
const markupInput = quoteContext(
  quoteText(markup, { node: markupCode, offset: lineEnd }, { node: markupCode, offset: codeValue.indexOf("()\n}") + 2 }),
  "m1",
  undefined
)
assert.deepEqual(markupInput, {
  // Starting at the end of the line above: its newline is dropped, the indentation kept.
  detail: { kind: "quote", text: "```ts\n  return items.length > 0 && items[0] ? items[0] : fallback<T>()\n```", messageId: "m1" },
  label: "“return items.length > 0 &&…”",
})
for (const quoted of [markupText, markupInput?.label ?? "", JSON.stringify(markupInput)])
  assert.doesNotMatch(quoted, /&(?:amp|lt|gt|quot|#\d+);/, "no entity reaches a quote or its label")

/* ---------- labels and the payload ---------- */
assert.equal(quoteLabel(quoteText(paragraphs)), "“Restoring a draft on that promise…”")
assert.equal(quoteLabel("Short reply."), "“Short reply.”")
assert.equal(quoteLabel(quoteText(block)), "“const draft = drafts.get(key) if…”", "a code quote's label reads its code, not its fence")
assert.equal(quoteLabel("- **85** still have\n- none"), "“**85** still have none”")
assert.equal(quoteLabel("Supercalifragilisticexpialidociousnessly-long-word-without-spaces"), "“Supercalifragilisticexpialidociou…”")
for (const sample of [quoteText(paragraphs), quoteText(across), quoteText(nested), "x".repeat(200), "a b ".repeat(80)])
  assert.ok(quoteLabel(sample).length <= QUOTE_LABEL_LIMIT, `label stays within ${QUOTE_LABEL_LIMIT} characters: ${quoteLabel(sample)}`)

const input = quoteContext(quoteText(paragraphs, { node: first, offset: 0 }, { node: second, offset: 8 }), "m1", undefined)
assert.deepEqual(input, {
  detail: { kind: "quote", text: "Restoring a draft on that promise overwrites the paragraph the user has since typed.\n\nRead the", messageId: "m1" },
  label: "“Restoring a draft on that promise…”",
})
assert.ok(QuoteDetailSchema.safeParse(input?.detail).success, "the payload matches the shared contract")
assert.equal(quoteContext("   \n ", "m1", undefined), null, "whitespace alone quotes nothing")

const long = prose(...Array.from({ length: 120 }, (_, index) => el("p", {}, `Paragraph ${index}: ${"words ".repeat(14)}`)))
const longText = quoteText(long)
assert.ok(longText.length > QUOTE_LIMIT)
const capped = quoteContext(longText, "m1", undefined)
assert.equal(capped?.detail.kind, "quote")
assert.equal(capped?.detail.kind === "quote" ? capped.detail.text.length : 0, QUOTE_LIMIT, "a long quote is cut to the limit")
assert.equal(capped?.label, "“Paragraph 0: words words words…” · first 8,000 characters", "the label says the quote was cut")
const emoji = quoteContext(`${"a".repeat(QUOTE_LIMIT - 1)}😀 tail`, undefined, undefined)
assert.equal(emoji?.detail.kind === "quote" ? emoji.detail.text.length : 0, QUOTE_LIMIT - 1, "a cut never splits a surrogate pair")
assert.equal(emoji?.detail.kind === "quote" ? emoji.detail.messageId : "missing", undefined)

/* ---------- which conversation ---------- */
const live = (key: string, threadPath: string | undefined, nativeId: string | undefined): LiveAcpConversation => ({
  key,
  draftKey: key,
  kind: "live",
  harness: "fixture-agent",
  cwd: "/disposable",
  title: `Live ${key}`,
  threadPath,
  blocks: [],
  queued: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  permission: null,
  sending: false,
  canceling: false,
  session: { id: key, nativeId, harness: "fixture-agent", cwd: "/disposable", connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] },
})
const acp: AcpState = {
  activeKey: "live-a",
  conversations: {
    "live-a": live("live-a", "/store/a.jsonl", "native-a"),
    "live-b": live("live-b", "/store/b.jsonl", "native-b"),
    "live-c": live("live-c", undefined, undefined),
  },
}
const stored: ThreadRef = { harness: "other-agent", nativeId: "native-x", identity: "identity-x", path: "/store/x.jsonl", title: "Fix the sign-in loop" }
const catalogB: ThreadRef = { harness: "fixture-agent", nativeId: "native-b", path: "/store/b.jsonl", title: "Pane B" }
const none = { viewing: null, threads: [stored, catalogB] }
assert.equal(quoteConversation({ liveId: "live-a" }, acp, none), undefined, "the conversation the composer sends to needs no reference")
assert.equal(quoteConversation({}, acp, none), undefined, "the built-in session's transcript names no other conversation")
assert.deepEqual(
  quoteConversation({ liveId: "live-b" }, acp, none),
  { harness: "fixture-agent", id: "native-b", title: "Pane B" },
  "another pane's live conversation is named through its catalogue entry"
)
assert.equal(quoteConversation({ liveId: "live-c" }, acp, none), undefined, "a live start with no native id can't be referenced")
assert.deepEqual(
  quoteConversation({ threadPath: stored.path }, acp, none),
  { harness: "other-agent", id: "identity-x", title: "Fix the sign-in loop" },
  "a stored thread is named by its reference id (identity before native id)"
)
const viewing = { viewing: { ref: stored }, threads: [] }
assert.equal(
  quoteConversation({ threadPath: stored.path }, { activeKey: null, conversations: {} }, viewing),
  undefined,
  "the viewed thread the composer continues is this conversation"
)
assert.deepEqual(
  quoteConversation({ liveId: "live-a" }, acp, viewing),
  { harness: "fixture-agent", id: "native-a", title: "Live live-a" },
  "while a viewed thread owns the composer, the live transcript is another conversation"
)

console.log("quote reply: selection to QuoteDetail checks passed")
