import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { z } from "zod"
import { VOCABULARIES } from "../../packages/sessions/src/harnesses/index.ts"
import { TOOL_KINDS, type ToolKind } from "../../packages/sessions/src/tool-identity.ts"
import { compareVersions, diffDefinitions, storedDefinitions, toolsAcross } from "../native-tools.ts"
import { FIXTURE_ROOT } from "../native-decoding.ts"
import type { PairFinding } from "./native-kinds.ts"

/**
 * What the daily bump (`scripts/bump-harness-versions.ts`) writes besides the declaration: each record a version
 * check holds to `tested` (`test-harness-definitions.ts`, `test-native-tools.ts`, `test-harness-concepts.ts`), moved
 * once the bump's own recording of the new build backs it, and what it found the new build does that Mako has no
 * place for yet, each said where it must be placed and, where the bump can tell, how.
 */

const REPO = join(import.meta.dirname, "..", "..")

export const vocabularyFile = (harness: string) => join(REPO, "packages/sessions/src/harnesses", `${harness}.ts`)

/** A version as a record writes it: a bundled runtime's vocabulary says `SDK 1.4.0`. */
const plain = (version: string) => version.replace(/^SDK /, "")

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** `text` with its first `from` (whole, not inside a longer version) replaced by `to`. */
function firstVersion(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`(?<![\\d.])${escape(from)}(?![\\d])`), to)
}

/** A phrase for a string literal: double quotes and backslashes escaped as the source writes them. */
const literal = (text: string) => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

/**
 * Moves one `checked` block of a vocabulary (its tools' or its concepts') from `from` to `to`: its version, its day,
 * and its `against`, whose first naming of the old build now names the new one, with `note` added as what this build
 * changed. Only a block at `from` moves; the storage block, checked on another build, is left as it is. False when
 * the file has no such block.
 */
interface CheckedMove {
  text: string
  moved: boolean
}

function moveChecked(text: string, which: "tools" | "concepts", from: string, to: string, today: string, note: string, also?: { from: string; to: string }): CheckedMove {
  // The tools' block is the definition's first `checked`; the concepts' is the one inside `concepts: {`.
  const start = which === "tools" ? text.indexOf("defineVocabulary(") : text.indexOf("\n  concepts: {")
  if (start < 0) return { text, moved: false }
  const pattern = /checked: \{\s*version: "(SDK )?([^"]+)",\s*on: "(\d{4}-\d{2}-\d{2})",\s*against: "((?:[^"\\]|\\.)*)"/y
  const at = text.indexOf("checked: {", start)
  if (at < 0) return { text, moved: false }
  pattern.lastIndex = at
  const match = pattern.exec(text)
  if (!match || plain(match[2]!) !== from) return { text, moved: false }
  const [whole, sdk = "", , , against] = match
  let next = firstVersion(against!, from, to)
  if (also) next = firstVersion(next, also.from, also.to)
  next = `${next}; ${literal(note)}`
  // Replaced through functions, so a `$` in the words is never read as a replacement pattern.
  const replaced = whole.replace(`version: "${sdk}${match[2]}"`, () => `version: "${sdk}${to}"`).replace(`on: "${match[3]}"`, () => `on: "${today}"`)
    .replace(`against: "${against}"`, () => `against: "${next}"`)
  return { text: text.slice(0, at) + replaced + text.slice(at + whole.length), moved: true }
}

/** What the new build's tools changed since the one the vocabulary was checked on, in a few words for its record. */
export function toolChanges(harness: string, from: string, to: string): string {
  const stored = storedDefinitions(harness)
  const before = stored.find((definitions) => definitions.version === from)
  const after = stored.find((definitions) => definitions.version === to)
  if (!before || !after) return `${to} recorded by the daily bump`
  const changes = new Set(diffDefinitions(before, after).map((line) => line.trim()).filter((line) => /^[~+-] /.test(line) && !line.includes(" configuration ")))
  if (!changes.size) return `${to} changes no tool (daily bump, ${after.on})`
  const words = [...changes].map((line) => line.replace(/^~ (\S+): description reworded \(.*\)$/, "$1's description reworded").replace(/^\+ (\S+)$/, "adds $1").replace(/^- (\S+)$/, "drops $1")
    .replace(/^\+ (\S+)\.(\S+): (.*)$/, "$1 takes $2 ($3)").replace(/^- (\S+)\.(\S+)$/, "$1 no longer takes $2").replace(/^~ /, ""))
  return `${to}: ${[...new Set(words)].join(", ")} (daily bump, ${after.on})`
}

const ConceptsFixture = z.object({ version: z.string(), probed: z.number(), missing: z.array(z.string()) }).loose()

/** The concepts fixture `harness:self-report` wrote, when it's of `version`. */
export function conceptsFixture(harness: string, version: string): z.infer<typeof ConceptsFixture> | undefined {
  const file = join(import.meta.dirname, "..", "fixtures", "native-vocabulary", `${harness}-concepts.json`)
  if (!existsSync(file)) return undefined
  const fixture = ConceptsFixture.parse(JSON.parse(readFileSync(file, "utf8")))
  return fixture.version === version ? fixture : undefined
}

export interface Moved {
  tools: boolean
  concepts: boolean
}

/**
 * Moves the vocabulary's tools and concepts records from `from` to `to`, each only once this run recorded the new
 * build for it: the tools once `harness:native-tools` wrote `<harness>-<to>.json`, the concepts once
 * `harness:self-report` wrote a fixture of `to`. A record whose recording is missing stays, and the version check
 * then names it.
 */
export function moveVocabulary(harness: string, from: string, to: string, today: string, bundled?: { from: string; to: string }): Moved {
  const file = vocabularyFile(harness)
  let text = readFileSync(file, "utf8")
  const recorded = storedDefinitions(harness).some((definitions) => definitions.version === to)
  const tools = recorded ? moveChecked(text, "tools", from, to, today, toolChanges(harness, from, to), bundled) : { text, moved: false }
  text = tools.text
  const fixture = conceptsFixture(harness, to)
  const concepts = fixture
    ? moveChecked(text, "concepts", from, to, today, `${to}: the build has every declared name (${fixture.probed} probed; daily bump)`, bundled)
    : { text, moved: false }
  writeFileSync(file, concepts.text)
  return { tools: tools.moved, concepts: concepts.moved }
}

/**
 * `how` in a declaration names the build its records were checked on: each naming of the old tested (and the old
 * bundled package) now names the new one. A `how` that names neither (one written for an older build) is left.
 */
export function moveHow(file: string, from: string, to: string, bundled?: { from: string; to: string }): boolean {
  const text = readFileSync(file, "utf8")
  const match = /how: "((?:[^"\\]|\\.)*)"/.exec(text)
  if (!match) return false
  const every = (words: string, old: string, next: string) => words.replace(new RegExp(`(?<![\\d.])${escape(old)}(?![\\d])`, "g"), next)
  let how = every(match[1]!, from, to)
  if (bundled) how = every(how, bundled.from, bundled.to)
  if (how === match[1]) return false
  writeFileSync(file, text.replace(match[0], () => `how: "${how}"`))
  return true
}

/**
 * Moves an exact pin of `name` in a package.json by editing its text, leaving every other byte as written: npm's
 * `install <name>@<version>` writes the whole file back through JSON.stringify, which rewrote the root's
 * `"Copyright ©"` as `©` on every bump.
 */
export function movePin(file: string, name: string, version: string): boolean {
  const text = readFileSync(file, "utf8")
  const pattern = new RegExp(`("${escape(name)}": ")\\d[^"]*(")`, "g")
  const next = text.replace(pattern, `$1${version}$2`)
  if (next === text) return false
  writeFileSync(file, next)
  return true
}

/* --------------------------------------------------------------- judgements */

/** Something the new build does that Mako has no place for: what, where it must be placed, and what the bump proposes. */
export interface Judgement {
  what: string
  where: string
  proposal?: string
}

const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** Kinds by what a name says, for a tool no harness has named before. */
const BY_WORD: [RegExp, ToolKind][] = [
  [/^(bash|shell|exec|command|terminal|run)$/, "shell"],
  [/^(read|view|cat|open)$/, "read"],
  [/^(edit|patch|replace)$/, "edit"],
  [/^(write|create)$/, "write"],
  [/^(delete|remove)$/, "delete"],
  [/^(grep|search)$/, "search"],
  [/^(glob|find)$/, "find"],
  [/^(ls|list)$/, "list"],
  [/^(fetch|url)$/, "web-fetch"],
  [/^(image|images|video)$/, "image"],
  [/^(todo|todos)$/, "todo"],
  [/^(plan)$/, "plan"],
  [/^(question|ask)$/, "question"],
  [/^(agent|subagent|spawn|task)$/, "agent"],
  [/^(message|send)$/, "agent-message"],
  [/^(wait|sleep)$/, "wait"],
  [/^(skill)$/, "skill"],
  [/^(mcp)$/, "mcp"],
]

/**
 * The kind a new tool most likely is: the kind another harness gives a tool of the same name, else of the name
 * sharing the most words with it, else what its words say. Undefined when nothing says.
 */
export function proposeKind(name: string, harness?: string): { kind: ToolKind; because: string } | undefined {
  let best: { kind: ToolKind; because: string; score: number } | undefined
  const mine = words(name)
  for (const vocabulary of VOCABULARIES)
    for (const [other, tool] of Object.entries(vocabulary.tools)) {
      const theirs = words(other)
      // Shared words, the first (what the tool works on: `image_edit` is an image tool) and the harness's own counting most.
      const shared = theirs.filter((word) => mine.includes(word)).length
      const weight = shared + (shared && theirs[0] === mine[0] ? 0.5 : 0) + (shared && vocabulary.harness === harness ? 0.25 : 0)
      const score = other === name ? 100 : weight / Math.max(theirs.length, mine.length)
      if (score >= 0.5 && (!best || score > best.score)) best = { kind: tool.kind, because: `${vocabulary.harness}'s ${other} is ${tool.kind}`, score }
    }
  if (best) return { kind: best.kind, because: best.because }
  for (const word of words(name))
    for (const [pattern, kind] of BY_WORD) if (pattern.test(word)) return { kind, because: `its name says ${word}` }
  return undefined
}

const lineOf = (file: string, pattern: RegExp) => {
  const index = readFileSync(file, "utf8").split("\n").findIndex((line) => pattern.test(line))
  return index < 0 ? undefined : index + 1
}

/** Tools the newest recorded definitions carry that the vocabulary doesn't declare, as `test-native-tools.ts` finds them. */
export function newTools(harness: string): Judgement[] {
  const vocabulary = VOCABULARIES.find((entry) => entry.harness === harness)
  const newest = storedDefinitions(harness).at(-1)
  if (!vocabulary || !newest) return []
  const declared = new Set(Object.entries(vocabulary.tools).flatMap(([name, tool]) => [name, ...tool.aliases ?? []]))
  const file = vocabularyFile(harness)
  const at = lineOf(file, /^\s*tools: \{/)
  return [...toolsAcross(newest)].filter(([key, { tool }]) => !tool.placeholder && !declared.has(key.split(".").at(-1)!)).map(([key, { tool, in: configurations }]) => {
    const name = key.split(".").at(-1)!
    const proposed = proposeKind(name, harness)
    const parameters = Object.keys(tool.parameters ?? {})
    return {
      what: `${harness} ${newest.version} defines the tool \`${name}\` (${parameters.length ? `takes ${parameters.join(", ")}` : "no parameters"}; in ${configurations.length} of ${newest.configurations.length} configurations), which its vocabulary doesn't declare`,
      where: `${relative(REPO, file)}${at ? `:${at}` : ""}, \`tools\``,
      ...proposed && { proposal: `\`${name}: { kind: "${proposed.kind}" },\` (${proposed.because}; the kinds are ${TOOL_KINDS.join(", ")})` },
    }
  })
}

/** Names the concepts declare that the new build lacks (`harness:self-report`'s fixture). */
export function missingConcepts(harness: string, version: string): Judgement[] {
  const fixture = conceptsFixture(harness, version)
  if (!fixture?.missing.length) return []
  const file = vocabularyFile(harness)
  const at = lineOf(file, /^\s*concepts: \{/)
  return [{
    what: `${harness} ${version} no longer names ${fixture.missing.map((name) => `\`${name}\``).join(", ")}, which its concepts declare`,
    where: `${relative(REPO, file)}${at ? `:${at}` : ""}, \`concepts\``,
    proposal: "drop each from the concepts if the harness no longer reads it, or say where it moved",
  }]
}

const Unplaced = z.array(z.object({ where: z.string(), table: z.string(), file: z.string().optional(), line: z.number().optional(), kinds: z.array(z.object({ name: z.string(), context: z.string().optional() })) }))

/** Record kinds the new build can save that no table places (`test-harness-records.ts --report`). */
export function unplacedRecords(report: string): Judgement[] {
  if (!existsSync(report)) return []
  return Unplaced.parse(JSON.parse(readFileSync(report, "utf8"))).flatMap((entry) => entry.kinds.map((kind) => ({
    what: `${entry.where}: the build can save \`${kind.name}\`, which no table places${kind.context ? `; the build around it: \`${kind.context.replaceAll("`", "'")}\`` : ""}`,
    where: `${entry.file ?? "packages/sessions/src/harnesses"}${entry.line ? `:${entry.line}` : ""}, \`${entry.table}\``,
    proposal: "add it to the table, with a sentence in the table's comment saying what it is and why it's read, skipped or undrawn",
  })))
}

/** What the session flows found: new native kinds, differences no kept pair explains, an own-model budget spent. */
export function pairJudgements(findings: readonly PairFinding[]): Judgement[] {
  const judgements: Judgement[] = []
  const kinds = new Map<string, Extract<PairFinding, { kind: "unknown-kind" }>[]>()
  for (const finding of findings) if (finding.kind === "unknown-kind") kinds.set(`${finding.harness} ${finding.type}`, [...kinds.get(`${finding.harness} ${finding.type}`) ?? [], finding])
  for (const [, seen] of kinds) {
    const first = seen[0]!
    const placement = first.placement
    judgements.push({
      what: `${first.harness} sends \`${first.type}\`, which its decoder reports ${first.reason}, in ${seen.map((finding) => `${finding.scenario} (${finding.count}×)`).join(", ")}`,
      where: placement ? `${placement.file}:${placement.line}${placement.table ? `, \`${placement.table}\`` : ""}` : `packages/host/src/harnesses/${first.harness}/`,
      proposal: placement
        ? `place it beside \`${placement.known}\`${placement.table ? ` in \`${placement.table}\`` : ""} if it draws nothing new (the nearest kind the decoder knows); otherwise decode it, and record a fixture of it with \`npm run decode -- <stream> --fixture\``
        : "decode it, or list it with the kinds the decoder knows and draws nothing for",
    })
  }
  const differences = new Map<string, Extract<PairFinding, { kind: "unexplained" }>[]>()
  for (const finding of findings) if (finding.kind === "unexplained") differences.set(`${finding.side}${finding.line}`, [...differences.get(`${finding.side}${finding.line}`) ?? [], finding])
  for (const [, seen] of differences) {
    const first = seen[0]!
    judgements.push({
      what: `${first.side === "-" ? "only the live wire draws" : "only the store draws"} \`${first.line.slice(0, 300)}\` (${seen.map((finding) => `${finding.scenario}, ${finding.reader}`).join("; ")})`,
      where: seen.map((finding) => `scripts/fixtures/native-decoding/${finding.harness}/pairs/${finding.scenario}/pair.json`).filter((file, index, all) => all.indexOf(file) === index).join(", "),
      proposal: first.proposal
        ? `the reason ${first.proposal.from} gives the same difference: "${first.proposal.reason}"`
        : "fix the side that draws it wrong; or, if the harness itself stores something other than it streamed, give the difference its reason",
    })
  }
  for (const finding of findings) {
    if (finding.kind !== "budget") continue
    judgements.push({
      what: `${finding.harness}'s own model spent ${finding.spent} tokens, the run's budget of ${finding.budget}, before ${finding.left.join(", ")}`,
      where: ".github/workflows/harness-versions.yml, `OWN_MODEL_BUDGET_TOKENS`",
      proposal: "raise the budget for this run, or record the scenarios left by hand",
    })
  }
  return judgements
}

/** Every difference a kept pair of `harness` lists with no reason: what `test:decoders` fails on. */
export function emptyReasons(harness: string): Judgement[] {
  const root = join(FIXTURE_ROOT, harness, "pairs")
  if (!existsSync(root)) return []
  const Known = z.array(z.object({ side: z.string(), line: z.string(), reason: z.string() }).loose())
  const Pair = z.object({ stores: z.array(z.object({ reader: z.string(), known: Known }).loose()), replay: z.object({ known: Known }).optional() }).loose()
  return readdirSync(root).flatMap((name) => {
    const file = join(root, name, "pair.json")
    if (!existsSync(file)) return []
    const pair = Pair.parse(JSON.parse(readFileSync(file, "utf8")))
    return [...pair.stores.map((store) => ({ reader: store.reader, known: store.known })), ...pair.replay ? [{ reader: "replay", known: pair.replay.known }] : []]
      .flatMap(({ reader, known }) => known.filter((difference) => !difference.reason).map((difference) => ({
        what: `${name} (${reader}) lists \`${difference.side} ${difference.line.slice(0, 300)}\` with no reason`,
        where: relative(REPO, file),
      })))
  })
}

/** Why a harness's records still name the old build after the run: each a version check would fail on. */
export function staleRecords(harness: string, tested: string): Judgement[] {
  const vocabulary = VOCABULARIES.find((entry) => entry.harness === harness)
  if (!vocabulary) return []
  const out: Judgement[] = []
  const recordings = storedDefinitions(harness).map((definitions) => definitions.version).sort(compareVersions)
  if (recordings.at(-1) !== tested) out.push({ what: `no native-tools recording of ${tested} (newest: ${recordings.at(-1) ?? "none"})`, where: "`npm run harness:native-tools`'s step above" })
  if (!conceptsFixture(harness, tested)) out.push({ what: `no concepts fixture of ${tested}`, where: "`npm run harness:self-report`'s step above" })
  return out
}

/** A check that failed with nothing above naming why: said as it said it, never left a bare red row. */
export function unexplainedFailures(steps: readonly { name: string; ok: boolean; detail?: string }[], judgements: readonly Judgement[]): Judgement[] {
  const named = judgements.map((judgement) => `${judgement.what} ${judgement.where}`).join("\n")
  return steps.filter((step) => !step.ok).flatMap((step) => {
    const lines = (step.detail ?? "").split(" · ").filter(Boolean)
    // A row whose every line a judgement already carries (a tool, a kind, a pair) needs no second item.
    if (lines.length && lines.every((line) => /defines tools its vocabulary doesn't declare|doesn't place|not explained|listed without a reason/.test(line) && judgements.length)) return []
    if (lines.length && lines.every((line) => named.includes(line))) return []
    return [{
      what: `${step.name} failed: ${step.detail ?? "with no words of its own"}`,
      where: "the step's log in this run",
      proposal: /^grok\/|^claude\/|^codex\/|^cursor\/|^devin\/|^opencode\/|✗ \w+\/[\w-]+ step/.test(step.detail ?? "")
        ? "a standalone decoder fixture (scripts/fixtures/native-decoding/<harness>/<fixture>.json) now decodes a step otherwise: the decoder's tables changed, or the fixture's kind needs placing; `npm run test:decoders` names the step"
        : undefined,
    }].map((judgement) => judgement.proposal === undefined ? { what: judgement.what, where: judgement.where } : judgement)
  })
}

/** The judgements as the pull request's body says them. */
export function renderJudgements(judgements: readonly Judgement[]): string {
  if (!judgements.length) return ""
  return [
    `### Needs a person: ${judgements.length} ${judgements.length === 1 ? "thing" : "things"} this release does that Mako has no place for yet`,
    "",
    "Everything else this bump changes was finished by the bot. Place each of these, push to this branch, and its checks rerun.",
    "",
    ...judgements.map((judgement, index) => [
      // A report quoted whole (a patch's) stays inside its item.
      `${index + 1}. ${judgement.what.includes("\n") ? judgement.what.trimEnd().replaceAll("\n", "\n   ") : `${judgement.what}.`}`,
      `   - **Where:** ${judgement.where}`,
      ...judgement.proposal ? [`   - **Proposed:** ${judgement.proposal}`] : [],
    ].join("\n")),
  ].join("\n")
}
