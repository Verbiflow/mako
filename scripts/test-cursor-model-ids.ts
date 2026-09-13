import assert from "node:assert/strict"
import type { SessionModel as HarnessModel } from "@mako/sessions/settings"
import {
  describeCursorCliModel,
  parseCursorModelList,
  parseCursorSelection,
  resolveCursorCliModel,
} from "../electron/providers/cursor/model-ids.ts"

// A slice of `cursor-agent --list-models` as printed on 2026-09-12
// (cursor-agent 2026.09.10): irregular on purpose.
const listing = `Available models

auto - Auto (default)
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex-low-fast - Codex 5.3 Low Fast
gpt-5.3-codex - Codex 5.3
gpt-5.3-codex-fast - Codex 5.3 Fast
gpt-5.3-codex-high - Codex 5.3 High
gpt-5.5-none - GPT-5.5 None
gpt-5.5-medium - GPT-5.5 Medium
gpt-5.5-extra-high - GPT-5.5 Extra High
gpt-5.5-extra-high-fast - GPT-5.5 Extra High Fast
cursor-grok-4.6-low - Cursor Grok 4.6 Low
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
claude-opus-4-8-low - Claude Opus 4.8 Low
claude-opus-4-8-high - Claude Opus 4.8 High
claude-opus-4-8-high-fast - Claude Opus 4.8 High Fast
claude-opus-4-8-thinking-high - Claude Opus 4.8 Thinking High
claude-opus-4-8-thinking-high-fast - Claude Opus 4.8 Thinking High Fast
claude-fable-5-high - Claude Fable 5 High
claude-fable-5-thinking-max - Claude Fable 5 Thinking Max
gpt-5.4-mini-low - GPT-5.4 Mini Low
gpt-5.4-low - GPT-5.4 Low
gpt-5.4-xhigh - GPT-5.4 XHigh
muse-spark-1.3-high - Muse Spark 1.3 High

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`
const ids = parseCursorModelList(listing)
assert.equal(ids[0], "auto")
assert.equal(ids.length, 25, "every id line is read, headers and tips are not")
assert.ok(!ids.includes("Tip:"))

const pick = (model: string | undefined, options?: Record<string, string | boolean>, defaultLevel?: string) =>
  resolveCursorCliModel({ model, options }, ids, defaultLevel)?.id

// Claude: thinking and effort and fast all live in the id.
assert.equal(pick("claude-opus-4-8", { thinking: "true", effort: "high", fast: "false" }), "claude-opus-4-8-thinking-high")
assert.equal(pick("claude-opus-4-8", { thinking: "true", effort: "high", fast: "true" }), "claude-opus-4-8-thinking-high-fast")
assert.equal(pick("claude-opus-4-8", { thinking: "false", effort: "high" }), "claude-opus-4-8-high")
assert.equal(pick("claude-opus-4-8", { effort: "low", context: "1m" }), "claude-opus-4-8-low", "context has no command-line form and is dropped")
// A combination the list does not offer is refused, never rounded to a neighbour.
assert.equal(pick("claude-fable-5", { thinking: "true", effort: "high" }), undefined)
// GPT: `reasoning`, hyphenated levels, and a bare id that means medium.
assert.equal(pick("gpt-5.5", { reasoning: "extra-high", fast: "true" }), "gpt-5.5-extra-high-fast")
assert.deepEqual(resolveCursorCliModel({ model: "gpt-5.3-codex", options: { reasoning: "medium" } }, ids, "medium"), { id: "gpt-5.3-codex", bareLevel: "medium" }, "the catalog's default level is the bare id when no id spells it, and the choice says so")
assert.equal(pick("gpt-5.3-codex", { reasoning: "medium" }), undefined, "without the catalog default nothing claims the bare id")
assert.equal(pick("gpt-5.3-codex", { reasoning: "extra-high" }, "medium"), undefined, "a non-default level no id spells is refused, not run as the bare default")
assert.equal(pick("gpt-5.3-codex", { reasoning: "medium", fast: "true" }, "medium"), "gpt-5.3-codex-fast")
assert.equal(pick("gpt-5.3-codex", { reasoning: "high", fast: "true" }, "medium"), undefined, "a listed level without its fast form is not the bare fast id")
// One level, two spellings: the requested one wins when listed, the other answers when only it is.
assert.equal(pick("gpt-5.4", { reasoning: "extra-high" }), "gpt-5.4-xhigh")
assert.equal(pick("gpt-5.5", { reasoning: "extra-high" }), "gpt-5.5-extra-high")
assert.equal(pick("gpt-5.5", { reasoning: "xhigh" }), "gpt-5.5-extra-high")
assert.equal(pick("gpt-5.4", { reasoning: "low" }), "gpt-5.4-low", "a longer sibling id never answers for its prefix")
// Grok carries a prefix; auto-smart is auto; composer has only fast.
assert.equal(pick("grok-4.6", { effort: "high", fast: "true" }), "cursor-grok-4.6-high-fast")
assert.equal(pick("auto-smart", { optimize_for: "balanced" }), "auto")
assert.equal(pick("composer-2.5", { fast: true }), "composer-2.5-fast")
assert.equal(pick("composer-2.5", { fast: false }), "composer-2.5")
// The bracket form Mako once wrote still reads; options override it.
assert.equal(pick("claude-opus-4-8[effort=high,fast=true]"), "claude-opus-4-8-high-fast")
assert.equal(pick("claude-opus-4-8[effort=low,fast=true]"), undefined, "an unlisted fast form is refused rather than run without fast")
assert.equal(pick("claude-opus-4-8[effort=low]", { effort: "high" }), "claude-opus-4-8-high")
assert.deepEqual([...parseCursorSelection({ model: "x[thinking,fast=true]" }).tokens], ["thinking", "fast"])
// Nothing is invented for a model the account does not list.
assert.equal(pick("claude-sonnet-4-6", { effort: "high" }), undefined)
assert.equal(pick(undefined, { effort: "high" }), undefined)
assert.equal(pick("muse-spark-1.3", { effort: "xhigh" }), undefined, "an unlisted level is not rounded to another")

// Reading an id back names the catalog model that owns it, longest base first.
const catalog = (
  [
    ["gpt-5.4", ["low", "medium", "high", "extra-high"]],
    ["gpt-5.4-mini", ["low", "medium"]],
    ["claude-opus-4-8", ["low", "high"]],
    ["grok-4.6", ["high"]],
    ["auto-smart", []],
    ["composer-2.5", []],
  ] as const
).map(([id, levels]): HarnessModel => ({
  id,
  label: id,
  options: levels.length
    ? [{ kind: "select", id: "effort", label: "Effort", values: levels.map((value) => ({ value, label: value })) }]
    : [],
}))
assert.deepEqual(describeCursorCliModel("claude-opus-4-8-thinking-high-fast", catalog), { model: "claude-opus-4-8", options: { thinking: "true", fast: "true", effort: "high" } })
assert.deepEqual(describeCursorCliModel("gpt-5.4-mini-low", catalog), { model: "gpt-5.4-mini", options: { thinking: "false", fast: "false", effort: "low" } })
assert.deepEqual(describeCursorCliModel("gpt-5.4-xhigh", catalog), { model: "gpt-5.4", options: { thinking: "false", fast: "false", effort: "extra-high" } }, "a level reads back in the catalog's spelling")
assert.deepEqual(describeCursorCliModel("cursor-grok-4.6-high-fast", catalog), { model: "grok-4.6", options: { thinking: "false", fast: "true", effort: "high" } })
assert.deepEqual(describeCursorCliModel("auto", catalog), { model: "auto-smart", options: { thinking: "false", fast: "false" } })
assert.deepEqual(describeCursorCliModel("mystery-9", catalog), { model: "mystery-9", options: { thinking: "false", fast: "false" } })
console.log("Cursor CLI model ids: listing parsed, thinking/effort/fast folded, GPT bare-medium declared, Grok prefix, auto alias, brackets read, unlisted refused, ids read back")
