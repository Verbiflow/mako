import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionModel } from "@mako/sessions/settings"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import { finTuningLine, finTuningWords, resolveFinTuning, type FinTuning, type FinTuningInput } from "@mako/host/contracts/fin-tuning"
import { FinDefaultsStore } from "@mako/host/harnesses/fin-defaults"
import { resetWords, spentUntil } from "@mako/host/contracts/account-usage"
import { FIN_CEILING, FIN_CEILING_MAX, FIN_LIMIT_MAX, finPolicyNote } from "@mako/host/contracts/fin-tuning"
import { recordedCatalog } from "./model-catalogs.ts"

/**
 * What a Fin runs on (`resolveFinTuning`), on each harness's catalog as Mako
 * recorded it (`scripts/fixtures/model-catalogs`), and OpenCode's as its own
 * normalizer reads a person's providers, since OpenCode records none.
 */

const catalog = (harness: string): readonly SessionModel[] => {
  const recorded = recordedCatalog(harness)
  assert.ok(recorded, `${harness} has a recorded catalog`)
  return recorded.models
}
const opencode = normalizeOpenCodeModels([
  { id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5", variants: { low: {}, high: {}, max: {} }, defaultVariant: "high" },
  { id: "gpt-6-sol", providerID: "openai", name: "GPT-6 Sol", variants: { medium: {}, high: {} } },
  { id: "qwen-4-coder", providerID: "ollama", name: "Qwen 4 Coder" },
]).models
const catalogs = new Map<string, readonly SessionModel[]>([
  ["claude", catalog("claude")],
  ["codex", catalog("codex")],
  ["cursor", catalog("cursor")],
  ["devin", catalog("devin")],
  ["grok", catalog("grok")],
  ["opencode", opencode],
])
const LABELS = new Map([["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"], ["devin", "Devin"], ["grok", "Grok"], ["opencode", "OpenCode"]])
/** Mako's pick for each harness, as its profile declares it (`HarnessDefaults.work`); OpenCode names none. */
const MAKO = new Map<string, NonNullable<FinTuningInput["recommended"]>>([
  ["claude", { model: "claude-opus-5-5", options: { effort: "high", fast: false } }],
  ["codex", { model: "gpt-6.1-sol", options: { effort: "medium", serviceTier: "default" } }],
  ["cursor", { model: "claude-opus-5-5", options: { effort: "high", fast: "false" } }],
  ["devin", { model: "swe-2", options: { effort: "high" } }],
  ["grok", { model: "grok-4.7", options: { effort: "high" } }],
])

function fin(harness: string, input: Partial<Omit<FinTuningInput, "label" | "models">> = {}): FinTuning {
  const recommended = MAKO.get(harness)
  return resolveFinTuning({ label: LABELS.get(harness)!, models: catalogs.get(harness)!, asked: {}, ...(recommended && { recommended }), ...input })
}
function ran(harness: string, input: Partial<Omit<FinTuningInput, "label" | "models">> = {}) {
  const tuning = fin(harness, input)
  assert.ok(!("refused" in tuning), `${harness}: ${JSON.stringify(input)} was refused: ${"refused" in tuning ? tuning.refused : ""}`)
  const words = finTuningWords(catalogs.get(harness)!, tuning.settings)
  return { ...tuning, line: words && finTuningLine(words) }
}
function refused(harness: string, input: Partial<Omit<FinTuningInput, "label" | "models">>, says: RegExp) {
  const tuning = fin(harness, input)
  assert.ok("refused" in tuning, `${harness}: ${JSON.stringify(input)} should be refused, ran on ${JSON.stringify(tuning)}`)
  assert.match(tuning.refused, says)
}

// ── Claude: an effort ladder and a fast lane on each model; Haiku has no levels.
{
  const apex = { model: "claude-opus-5-5", options: { effort: "xhigh", fast: true, agentTeams: true } }
  const same = ran("claude", { apex })
  assert.equal(same.source, "apex", "a Fin on its Apex's harness runs on the Apex's model")
  assert.deepEqual(same.settings, apex, "with every option the Apex runs on, fast lane included")
  assert.equal(same.line, "Opus 5.5 · Extra high · Fast")
  const plain = ran("claude")
  assert.equal(plain.source, "mako", "with nothing the person chose, Mako's pick")
  assert.deepEqual(plain.settings, MAKO.get("claude"))
  const named = ran("claude", { apex, asked: { model: "sonnet 5", reasoning: "extra high" } })
  assert.deepEqual(named.settings, { model: "claude-sonnet-5", options: { effort: "xhigh" } }, "a named model by its name, and a level in words")
  assert.equal(named.source, "asked")
  const faster = ran("claude", { asked: { fast: true } })
  assert.deepEqual(faster.settings, { model: "claude-opus-5-5", options: { effort: "high", fast: true } }, "fast without a model puts the person's model on its fast lane")
  refused("claude", { asked: { model: "haiku", reasoning: "high" } }, /Haiku 4\.5 on Claude has no reasoning levels.*Opus 5\.5 \(low, medium, high, xhigh or max\)/)
  refused("claude", { asked: { model: "opus 5.5", reasoning: "ultra" } }, /takes reasoning low, medium, high, xhigh or max, not ultra/)
  refused("claude", { asked: { model: "gpt-6" } }, /Claude has no model "gpt-6"\. Its models: Opus 5\.5 \(claude-opus-5-5\)/)
  refused("claude", { asked: { model: "sonnet 5.5" } }, /lists Sonnet 5\.5 but can't start it/)
  const dated = ran("claude", { asked: { model: "claude-haiku-4-5-20251001" } })
  assert.equal(dated.line, "Haiku 4.5", "a model without levels shows none")
}

// ── Codex: its fast lane is the priority service tier; plan mode is the Apex's, never carried.
{
  const apex = { model: "gpt-6-astra", options: { effort: "xhigh", serviceTier: "priority", plan: true } }
  const same = ran("codex", { apex })
  assert.deepEqual(same.settings, { model: "gpt-6-astra", options: { effort: "xhigh", serviceTier: "priority" } }, "an Apex in plan mode doesn't start its Fins in it")
  assert.equal(same.line, "GPT-6-Astra · Extra high · Fast")
  const onHigh = ran("codex", { asked: { reasoning: "high" } })
  assert.deepEqual(onHigh.settings, { model: "gpt-6.1-sol", options: { effort: "high", serviceTier: "default" } }, "\"Codex on high\" from a Claude Apex: Mako's Codex pick on high")
  const used = ran("codex", { used: { model: "gpt-6-luna", options: { effort: "low" } }, asked: { reasoning: "high", fast: true } })
  assert.deepEqual(used.settings, { model: "gpt-6-luna", options: { effort: "high", serviceTier: "priority" } }, "the person's last Codex model, on high and the fast lane")
  assert.equal(used.source, "used")
  const chosen = ran("codex", { chosen: { model: "gpt-5.6-terra", options: { effort: "max" } }, apex, used: { model: "gpt-6-luna" } })
  assert.equal(chosen.source, "fins", "Settings › Fins outranks what the person uses, even on the Apex's harness")
  assert.deepEqual(chosen.settings, { model: "gpt-5.6-terra", options: { effort: "max" } })
  refused("codex", { asked: { model: "daybreak", fast: true } }, /Daybreak Blue on Codex has no fast lane.*GPT-6\.1-Sol/)
  assert.deepEqual(ran("codex", { asked: { model: "GPT-6.1-Sol", reasoning: "Ultra" } }).settings, { model: "gpt-6.1-sol", options: { effort: "ultra" } }, "ids and levels in any case")
}

// ── Cursor: options are encoded in model variants, and Auto is its own default, never Mako's.
{
  const variant = "claude-opus-5-5[context=1m,effort=max,fast=true]"
  const same = ran("cursor", { apex: { model: variant } })
  assert.equal(same.settings?.model, "claude-opus-5-5", "an Apex on a variant id gives its Fin the model")
  assert.deepEqual(same.settings?.options, { context: "1m", effort: "max", fast: "true" }, "and every option the variant encodes")
  assert.equal(same.line, "Claude Opus 5.5 · Max · Fast")
  const plain = ran("cursor")
  assert.deepEqual(plain.settings, MAKO.get("cursor"), "with nothing chosen, Mako's pick: not Auto")
  assert.equal(plain.line, "Claude Opus 5.5 · High")
  const auto = ran("cursor", { used: { model: "auto-smart" } })
  assert.equal(auto.settings?.model, "auto-smart", "Auto when the person chose it themselves")
  assert.deepEqual(ran("cursor", { asked: { model: "composer 2.5", fast: true } }).settings, { model: "composer-2.5", options: { fast: "true" } })
  refused("cursor", { asked: { model: "gemini-3.8-flash", fast: true } }, /Gemini 3\.8 Flash on Cursor has no fast lane.*Composer 2\.5/)
  const gone = ran("cursor", { chosen: { model: "gpt-4o", options: { effort: "high" } }, used: { model: "gpt-5.5", options: { effort: "extra-high" } } })
  assert.equal(gone.source, "used", "a Fins default the harness stopped listing is passed over")
  assert.deepEqual(gone.notes, ["Your Fins default for Cursor, gpt-4o, isn't listed by Cursor anymore: it runs on GPT-5.5 instead."], "and says so")
  assert.equal(ran("cursor", { asked: { model: "opus" } }).settings?.model, "claude-opus-5-5", "an alias the catalog gives is the catalog's choice")
  refused("cursor", { asked: { model: "gemini 3" } }, /several models for "gemini 3": Gemini 3\.8 Flash \(gemini-3\.8-flash\), Gemini 3\.7 Flash/)
}

// ── Devin: variants per level, and its fast models are models of their own.
{
  assert.deepEqual(ran("devin", { asked: { reasoning: "max" } }).settings, { model: "swe-2", options: { effort: "max" } })
  const sibling = ran("devin", { asked: { model: "swe-1.6", fast: true } })
  assert.equal(sibling.settings?.model, "swe-1.6-fast", "fast on a model whose fast lane is its own model switches to it")
  assert.equal(ran("devin", { asked: { model: "swe-1.6-fast", fast: false } }).settings?.model, "swe-1.6", "and back")
  assert.deepEqual(ran("devin", { asked: { model: "opus 5.5", reasoning: "low", fast: true } }).settings, { model: "claude-opus-5.5", options: { effort: "low", fast: true } })
  refused("devin", { asked: { model: "adaptive", reasoning: "high" } }, /Adaptive on Devin has no reasoning levels/)
}

// ── Grok: no fast option; Grok 4.7 Fast is a model beside Grok 4.7.
{
  const faster = ran("grok", { asked: { fast: true } })
  assert.deepEqual(faster.settings, { model: "grok-4.7-build-fast", options: { effort: "high" } }, "the fast sibling keeps the level")
  assert.equal(faster.line, "Grok 4.7 Fast · High")
  assert.deepEqual(ran("grok", { asked: { model: "grok-4.7-build-fast", fast: true } }).settings, { model: "grok-4.7-build-fast" }, "fast on the fast one is already so")
  assert.deepEqual(ran("grok", { apex: { model: "grok-4.6", options: { effort: "xhigh" } } }).settings, { model: "grok-4.6", options: { effort: "xhigh" } })
  refused("grok", { asked: { model: "grok-4.6", fast: true } }, /Grok 4\.6 on Grok has no fast lane.*Grok 4\.7 Fast/)
}

// ── OpenCode: the person's own providers; Mako names no model, so its own configured one stands.
{
  const own = ran("opencode")
  assert.equal(own.source, "harness", "with nothing chosen, OpenCode's configured model")
  assert.equal(own.settings, undefined)
  const used = ran("opencode", { used: { model: "anthropic/claude-opus-5-5", options: { effort: "max" } } })
  assert.equal(used.line, "Claude Opus 5.5 · Max")
  assert.deepEqual(ran("opencode", { asked: { model: "gpt-6 sol", reasoning: "high" } }).settings, { model: "openai/gpt-6-sol", options: { effort: "high" } })
  refused("opencode", { asked: { model: "qwen 4 coder", fast: true } }, /no fast lane.*No OpenCode model has one/)
  refused("opencode", { asked: { reasoning: "high" } }, /names no model to set reasoning on/)
  const gone = ran("opencode", { used: { model: "ollama/llama-5" } })
  assert.equal(gone.source, "harness")
  assert.deepEqual(gone.notes, ["Your last model on OpenCode, ollama/llama-5, isn't listed by OpenCode anymore: it runs on OpenCode's own default."])
}

// ── A catalog not read yet holds nothing back, and can't tell a fast lane.
{
  const unread = resolveFinTuning({ label: "Cursor", models: [], asked: { model: "gpt-6", reasoning: "low" } })
  assert.deepEqual(unread, { settings: { model: "gpt-6", options: { effort: "low" } }, source: "asked", notes: [] })
  const fast = resolveFinTuning({ label: "Cursor", models: [], asked: { model: "gpt-6", fast: true } })
  assert.ok("refused" in fast && /haven't been read/.test(fast.refused))
  assert.deepEqual(resolveFinTuning({ label: "Cursor", models: [], asked: {}, apex: { model: "auto-smart" } }), { settings: { model: "auto-smart" }, source: "apex", notes: [] })
}

// ── The host's file: Settings › Fins and what the person used, read by every host of theirs and kept across a restart.
{
  const folder = mkdtempSync(join(tmpdir(), "mako-fin-defaults-"))
  try {
    const file = join(folder, "fin-defaults.json")
    const store = new FinDefaultsStore(file)
    assert.deepEqual(store.reading(), { chosen: {}, used: {}, policy: { rules: [] }, ceiling: FIN_CEILING, moveOnLimit: true }, "nothing chosen: every harness's Fins run as the person does, this device on its capacity, and go on at the next account when theirs runs out")
    store.use("cursor", { model: "composer-2.5", options: { fast: "true" } })
    store.use("cursor", { options: { effort: "high" } })
    store.choose("codex", { model: "gpt-6.1-sol", options: { effort: "high" } })
    assert.deepEqual(new FinDefaultsStore(file).reading(), {
      chosen: { codex: { model: "gpt-6.1-sol", options: { effort: "high" } } },
      used: { cursor: { model: "composer-2.5", options: { fast: "true" } } },
      policy: { rules: [] },
      ceiling: FIN_CEILING,
      moveOnLimit: true,
    }, "another host reads the same, and a send that names no model changes nothing")
    store.choose("codex", null)
    assert.deepEqual(store.reading().chosen, {}, "Same as you again")
    assert.throws(() => store.choose("codex", { options: { effort: "high" } }), /names a model/)
    const written = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(file, JSON.stringify({ ...written, chosen: { grok: { model: 7 }, claude: { model: "claude-opus-5-5" } } }))
    assert.deepEqual(new FinDefaultsStore(file).reading().chosen, { claude: { model: "claude-opus-5-5" } }, "an entry this build can't read is left out, never the rest")
    const rule = (id: string, when: string, harness: string) => ({ id, when, target: { harness } })
    const saved = new FinDefaultsStore(file).savePolicy({ rules: [rule("a", "  Anything that isn't frontend ", "codex"), rule("b", "UI", "claude")], otherwise: { harness: "cursor", settings: { model: "composer-2.5" } } })
    assert.deepEqual(saved.policy.rules.map((each) => each.when), ["Anything that isn't frontend", "UI"], "rules keep their order, trimmed")
    assert.throws(() => store.savePolicy({ rules: [rule("a", "x", "codex"), rule("a", "y", "claude")] }), /id of its own/)
    assert.throws(() => store.savePolicy({ rules: [rule("a", "   ", "codex")] }))
    const stored = JSON.parse(readFileSync(file, "utf8"))
    writeFileSync(file, JSON.stringify({ ...stored, policy: { ...stored.policy, rules: [...stored.policy.rules, { id: "c", when: 7 }] } }))
    assert.deepEqual(new FinDefaultsStore(file).reading().policy.rules.map((each) => each.id), ["a", "b"], "a rule this build can't read is left out, never the others")
    assert.equal(store.setLimit(4).limit, 4)
    assert.equal(new FinDefaultsStore(file).reading().limit, 4, "the limit is every host's")
    assert.deepEqual(new FinDefaultsStore(file).reading().policy.rules.map((each) => each.id), ["a", "b"], "and setting it keeps the rest")
    assert.throws(() => store.setLimit(0))
    assert.throws(() => store.setLimit(FIN_LIMIT_MAX + 1))
    assert.throws(() => store.setLimit(2.5))
    assert.equal("limit" in store.setLimit(null), false, "back to Auto: this device's capacity")
    assert.equal("limit" in JSON.parse(readFileSync(file, "utf8")), false, "Auto is kept as none chosen")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), limit: 99 }))
    assert.equal(new FinDefaultsStore(file).reading().limit, undefined, "a number this build can't take is Auto, never the rest unread")
    assert.equal(store.setCeiling(100).ceiling, 100)
    assert.equal(new FinDefaultsStore(file).reading().ceiling, 100, "the ceiling across places is kept too")
    assert.throws(() => store.setCeiling(0))
    assert.throws(() => store.setCeiling(FIN_CEILING_MAX + 1))
    assert.equal(store.setCeiling(FIN_CEILING).ceiling, FIN_CEILING)
    assert.equal("ceiling" in JSON.parse(readFileSync(file, "utf8")), false, "the default ceiling is kept as none chosen")
    assert.equal(store.chooseMoveOnLimit(false).moveOnLimit, false, "the switch turned off")
    assert.equal(JSON.parse(readFileSync(file, "utf8")).moveOnLimit, false)
    assert.equal(new FinDefaultsStore(file).reading().moveOnLimit, false, "another host reads it off")
    assert.equal(new FinDefaultsStore(file).reading().policy.rules.length, 2, "the switch changes nothing else")
    assert.equal(store.chooseMoveOnLimit(true).moveOnLimit, true)
    assert.equal("moveOnLimit" in JSON.parse(readFileSync(file, "utf8")), false, "on is the default, kept as nothing")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

// ── An account at its limit: a spent window not yet reset, until the latest such reset.
{
  const now = Date.UTC(2026, 10, 3, 18)
  const at = (hours: number) => now + hours * 3_600_000
  const reading = (windows: { usedPercent: number; resetsAt: number | null }[]) => ({ status: "ok" as const, windows: windows.map((window) => ({ ...window, windowMinutes: 300 })) })
  assert.equal(spentUntil(reading([{ usedPercent: 99, resetsAt: at(1) }]), now), undefined, "room left is room")
  assert.deepEqual(spentUntil(reading([{ usedPercent: 100, resetsAt: at(1) }, { usedPercent: 100, resetsAt: at(3) }]), now), { until: at(3) }, "every spent window must reset")
  assert.equal(spentUntil(reading([{ usedPercent: 100, resetsAt: at(-1) }]), now), undefined, "a window past its reset has emptied")
  assert.deepEqual(spentUntil(reading([{ usedPercent: 100, resetsAt: null }]), now), { until: null })
  assert.equal(spentUntil({ status: "error" }, now), undefined, "an unread account reads as room, never as a limit")
  assert.match(resetWords(at(2), now), /^\d{1,2}:\d{2} [AP]M \S+$/, "a reset today is its time")
  assert.match(resetWords(at(30), now), /^[A-Z][a-z]{2},? \d{1,2}:\d{2} [AP]M \S+$/, "a later one names its day")
}

// ── The note every Thread reads: nothing without rules, one line each with them.
assert.deepEqual(finPolicyNote({ rules: [] }, () => ""), [])
assert.deepEqual(finPolicyNote({ rules: [{ id: "a", when: "Tests\n and   fixtures", target: { harness: "codex" } }] }, (target) => target.harness), [
  "The person's rules for picking a Fin's harness and model, first fit wins. Pass its number as agents_start's rule, and leave harness, model, reasoning and fast out unless the person named them:",
  "1. Tests and fixtures → codex",
  "None fits: your own harness (leave rule out).",
])

console.log("fin tuning: the rule holds on Claude, Codex, Cursor, Devin, Grok and OpenCode")
