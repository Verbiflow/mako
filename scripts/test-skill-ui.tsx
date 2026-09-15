import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { SkillMatrix } from "../src/components/settings/skill-matrix"
import { SkillChip } from "../src/components/composer/reference-chip"
import { ReferenceOverlay } from "../src/components/composer/reference-overlay"
import { Prose } from "../src/components/transcript/markdown"
import { skillColumns, skillMatrixRows, skillCell, homeRelative } from "../src/lib/skill-matrix"
import { parseSkillAppendix } from "../src/lib/skill-references"
import { skillsStore } from "../src/state/skills"
import { threadsStore } from "../src/state/threads"
import type { SkillRecord, SkillRegistrySnapshot } from "../src/lib/types"

/**
 * The three places a skill's route to a provider is shown — the Settings
 * matrix, the draft's chip and the transcript's chip — all read one rule.
 * These checks render each with production components and assert what they
 * say, without a host.
 */

function skill(name: string, origins: Array<[provider: string, scope: "user" | "workspace", hash?: string]>, extra: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: name,
    name,
    description: `${name} description`,
    hash: "same",
    bytes: 1,
    files: 1,
    portable: true,
    origins: origins.map(([provider, scope, hash]) => ({ provider, account: "default", scope, provenance: `/Users/you/.${provider}/skills/${name}/SKILL.md`, hash: hash ?? "same" })),
    ...extra,
  }
}

const snapshot: SkillRegistrySnapshot = {
  cwd: "/repo",
  generatedAt: 0,
  providers: [
    { id: "claude", label: "Claude Code", account: "default", available: true, readsUniversalRoot: false },
    { id: "cursor", label: "Cursor", account: "default", available: false, readsUniversalRoot: false },
  ],
  skills: [
    skill("wait-what", [["agents", "user"]], { manual: true }),
    skill("grilling", [["claude", "user"], ["cursor", "user", "other"]], { conflict: "drift" }),
    skill("hyperframes", [["cursor", "workspace"]]),
  ],
}

/* Matrix ------------------------------------------------------------------ */

const columns = skillColumns(snapshot.providers)
assert.deepEqual(columns.map((column) => [column.id, column.universal, column.available]), [["agents", true, true], ["claude", false, true], ["cursor", false, false]])
const rows = skillMatrixRows(snapshot, columns)
assert.deepEqual(
  rows.map((row) => [row.skill.name, ...columns.map((column) => row.cells.get(column.id)?.state)]),
  [
    ["wait-what", "installed", "absent", "absent"],
    ["grilling", "absent", "installed", "drifted"],
    ["hyperframes", "absent", "absent", "installed"],
  ],
  "each cell reads the copy in that column against the listed hash"
)
assert.equal(skillMatrixRows(snapshot, columns, "cursor").length, 2, "the filter reaches provider names")
assert.equal(skillCell(rows[1]!.skill, "cursor").copies[0]?.hash, "other")
assert.equal(homeRelative("/Users/you/.claude/skills/a"), "~/.claude/skills/a")
assert.equal(homeRelative("/repo/.agents/skills/a"), "/repo/.agents/skills/a")

const matrix = renderToStaticMarkup(
  <TooltipProvider>
    <SkillMatrix rows={rows} columns={columns} />
  </TooltipProvider>
)
assert.match(matrix, /data-skill-column="agents"/)
assert.match(matrix, /data-skill-row="wait-what"/)
assert.match(matrix, /data-skill-cell="claude" data-cell-state="absent"/, "an absent cell is an outline the popover explains")
assert.match(matrix, /data-skill-cell="cursor" data-cell-state="drifted"/)
assert.match(matrix, /aria-label="grilling in Cursor differs from the listed copy"/)
assert.match(matrix, /aria-label="wait-what is not in Claude Code"/)
assert.match(matrix, />manual</, "a manual skill wears its badge in the row")
assert.match(matrix, /aria-label="Copies differ"/, "a drifted skill carries the caution mark in the row")
assert.doesNotMatch(matrix, /title="/, "the matrix uses tooltips and popovers, never a native title")

/* Chips ------------------------------------------------------------------- */

const native = renderToStaticMarkup(<SkillChip name="grilling" sent={{ name: "grilling" }} />)
assert.match(native, /data-skill-delivery="native"/)
assert.match(native, /title="Skill: grilling · the provider has it"/)
const handed = renderToStaticMarkup(<SkillChip name="wait-what" sent={{ name: "wait-what", from: "claude" }} />)
assert.match(handed, /data-skill-delivery="handover"/)
assert.match(handed, /handed over from Claude Code&#x27;s skills/)
assert.match(handed, /<svg[^>]*>[\s\S]*<svg/, "a handover chip carries the source mark after the book")
const universal = renderToStaticMarkup(<SkillChip name="wait-what" sent={{ name: "wait-what", from: "agents" }} />)
assert.match(universal, /universal skills folder/)
const missing = renderToStaticMarkup(<SkillChip name="nope" sent={null} />)
assert.match(missing, /data-skill-delivery="missing"/)
assert.match(missing, /outline-dashed/)
const unknown = renderToStaticMarkup(<SkillChip name="old" />)
assert.doesNotMatch(unknown, /data-skill-delivery="/, "a prompt from before resolution claims nothing")

/* The draft ---------------------------------------------------------------- */

skillsStore.set({ status: "ready", snapshot, previews: {} })
threadsStore.set({ composerHarness: "cursor" })
const overlay = renderToStaticMarkup(<ReferenceOverlay text="try $wait-what and $hyperframes, $grilling then $nope for $5" attachments={[]} />)
assert.match(overlay, /<span aria-hidden="true">\$5<\/span>/, "a price is prose, not a skill nothing has")
assert.doesNotMatch(overlay, /data-skill-delivery="[a-z]*"[^>]*>\$5</)
assert.match(overlay, /data-skill-delivery="handover"[^>]*>\$wait-what</, "a skill Cursor lacks is marked as handed over")
assert.match(overlay, /decoration-dotted[^>]*>\$wait-what</, "with a dotted underline, which takes no width")
assert.match(overlay, /data-skill-delivery="native"[^>]*>\$hyperframes</)
assert.match(overlay, /data-skill-delivery="native"[^>]*>\$grilling</, "a drifted copy is still the provider's own")
assert.match(overlay, />, </, "the comma after a token stays prose outside the chip")
assert.match(overlay, /data-skill-delivery="missing"[^>]*>\$nope</)
assert.doesNotMatch(overlay, /<svg/, "the overlay paints no glyphs: the caret belongs to the textarea")

/* The transcript ----------------------------------------------------------- */

const sent = "use $grilling please, under $5\n\n---\n[Skill grilling from claude] grilling description\nHanded over from Claude Code's skills. Apply these instructions now; supporting files are in /x/.\n\nBody"
const parsed = parseSkillAppendix(sent)
const prose = renderToStaticMarkup(<Prose text={parsed.body} references={[]} skills={parsed.skills} />)
assert.match(prose, /data-skill-delivery="handover"/, "the transcript chip reads the appendix the send wrote")
assert.doesNotMatch(prose, /Apply these instructions/, "the appendix itself never renders as prose")
assert.doesNotMatch(prose, /data-skill-delivery="missing"/, "a price in a sent prompt is not a missing skill")
assert.match(prose, /\$5/, "and stays in the words")

console.log("skill ui ok")
