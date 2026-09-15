import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SKILL_HANDOVER_LIMIT,
  skillDelivery,
} from "../electron/contracts/skill-reach.ts"
import {
  discoverSkillRecords,
  resolveSkillReferences,
  skillBody,
  type SkillRoot,
} from "../electron/skill-registry.ts"
import type {
  SkillProviderStatus,
  SkillReference,
  SkillRegistrySnapshot,
} from "../electron/shared.ts"
import {
  appendSkillReferences,
  parseSkillAppendix,
  skillNamesIn,
  stripSkillAppendix,
} from "../src/lib/skill-references.ts"

/**
 * A `$skill` typed for one provider must reach whichever provider answers.
 * The host decides how (`skill-reach.ts`), reads what a handover needs, and
 * the renderer writes it into the prompt under a marker the transcript reads
 * back. These checks cover the rule, the read, the appendix and the round
 * trip.
 */

const directory = await mkdtemp(join(tmpdir(), "mako-skill-references-"))

async function writeSkill(
  root: string,
  name: string,
  frontmatter: string,
  body: string
) {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`)
  return join(path, "SKILL.md")
}

function providers(readsUniversalRoot: boolean): SkillProviderStatus[] {
  return ["claude", "cursor"].map((id) => ({
    id,
    label: id,
    account: "default",
    available: true,
    readsUniversalRoot,
  }))
}

try {
  const agentsRoot = join(directory, ".agents", "skills")
  const claudeRoot = join(directory, ".claude", "skills")
  const cursorRoot = join(directory, ".cursor", "skills")
  await writeSkill(
    agentsRoot,
    "wait-what",
    'name: wait-what\ndescription: "Stop. That last message did not land: re-pitch it."\ndisable-model-invocation: true',
    "Re-explain the last message in plain language."
  )
  await writeSkill(
    claudeRoot,
    "grilling",
    "name: grilling\ndescription: Stress-test a plan through a focused interview.",
    "# Grilling\n\nAsk in small rounds.\n\n---\n\nA rule under a rule."
  )
  await writeSkill(
    cursorRoot,
    "hyperframes",
    "name: hyperframes\ndescription: Cursor-only skill.",
    "Cursor's own."
  )
  await writeSkill(
    claudeRoot,
    "huge",
    "name: huge\ndescription: Too big to carry.",
    "x".repeat(SKILL_HANDOVER_LIMIT + 1)
  )
  // A project copy of grilling that has drifted from the user copy.
  const projectClaudeRoot = join(directory, "repo", ".claude", "skills")
  await writeSkill(
    projectClaudeRoot,
    "grilling",
    "name: grilling\ndescription: Stress-test a plan through a focused interview.",
    "# Grilling, project edition\n\nAsk about this repository."
  )

  const roots: SkillRoot[] = [
    { provider: "agents", account: "local", scope: "user", root: agentsRoot },
    { provider: "claude", account: "default", scope: "user", root: claudeRoot },
    { provider: "cursor", account: "default", scope: "user", root: cursorRoot },
    { provider: "claude", account: "default", scope: "workspace", root: projectClaudeRoot },
  ]
  const skills = await discoverSkillRecords(roots)
  const snapshot: SkillRegistrySnapshot = {
    cwd: directory,
    generatedAt: 1,
    skills,
    providers: providers(false),
  }

  /* The frontmatter's own word reaches the record. */
  const waitWhat = skills.find((skill) => skill.name === "wait-what")
  assert.ok(waitWhat)
  assert.equal(waitWhat.manual, true, "disable-model-invocation marks the skill manual")
  assert.equal(skills.find((skill) => skill.name === "grilling")?.manual, undefined)

  /* The rule. */
  assert.deepEqual(skillDelivery(waitWhat, "cursor", snapshot.providers).kind, "handover", "an unverified provider is handed a universal skill")
  assert.deepEqual(skillDelivery(waitWhat, "cursor", providers(true)).kind, "native", "a verified reader loads the universal root itself")
  const grilling = skills.find((skill) => skill.name === "grilling")!
  assert.equal(grilling.conflict, "drift", "two copies with different content are a drift")
  assert.equal(grilling.origins.length, 2)
  const projectCopy = grilling.origins.find((origin) => origin.scope === "workspace")!
  const userCopy = grilling.origins.find((origin) => origin.scope === "user")!
  assert.notEqual(projectCopy.hash, userCopy.hash, "each copy records its own hash")
  assert.equal(userCopy.hash, grilling.hash, "the record's hash is the listed copy's")
  const grillingForClaude = skillDelivery(grilling, "claude", snapshot.providers)
  assert.deepEqual(grillingForClaude, { kind: "native", path: projectCopy.provenance }, "a provider's own project copy is the one it loads, so it is the one named")
  const grillingForCursor = skillDelivery(grilling, "cursor", snapshot.providers)
  assert.deepEqual(grillingForCursor, { kind: "handover", path: projectCopy.provenance, from: "claude" }, "a handover reads the project copy too")

  /* The read. */
  assert.equal(skillBody("---\nname: a\n---\n\nBody\n"), "Body")
  assert.equal(skillBody("No frontmatter at all"), "No frontmatter at all")
  const resolved = await resolveSkillReferences(
    snapshot,
    ["wait-what", "grilling", "hyperframes", "huge", "nope", "grilling"],
    "cursor"
  )
  assert.deepEqual(
    resolved.map((reference) => [reference.name, reference.delivery.kind, reference.body !== undefined, reference.oversize ?? false]),
    [
      ["wait-what", "handover", true, false],
      ["grilling", "handover", true, false],
      ["hyperframes", "native", false, false],
      ["huge", "handover", false, true],
      ["nope", "missing", false, false],
    ],
    "each name resolves once; a handover carries its body unless it is oversize; a native or missing skill carries none"
  )
  assert.equal(resolved[1]?.body, "# Grilling, project edition\n\nAsk about this repository.", "the body is the chosen copy's SKILL.md without its frontmatter")
  assert.equal(resolved[1]?.hash, projectCopy.hash, "the hash is the chosen copy's, not the listed copy's")
  assert.equal(resolved[0]?.description, "Stop. That last message did not land: re-pitch it.")
  assert.ok(resolved[0]?.hash)

  /* The names a draft references. */
  assert.deepEqual(skillNamesIn("use $wait-what and $grilling, then $wait-what again; costs $5 and $mcp:github"), ["wait-what", "grilling"], "skill tokens once each; a price and an mcp token are not skills")
  assert.deepEqual(skillNamesIn("about $2fa and $mcp:"), ["2fa"], "a digit may lead a name that has a letter; a half-typed $mcp: is still an mcp token")
  assert.deepEqual(skillNamesIn("/grilling this plan"), ["grilling"], "a leading slash is the same reference")
  assert.deepEqual(skillNamesIn("plain words"), [])

  /* The appendix. */
  const draft = "Please $grilling my plan and use $hyperframes; also $nope."
  const first = appendSkillReferences(draft, resolved)
  assert.ok(first.text.startsWith(draft), "the words stay first")
  assert.ok(first.text.includes("\n\n---\n[Skill wait-what from agents]"), "a handover marker names its source")
  assert.ok(first.text.includes("[Skill grilling from claude] Stress-test a plan through a focused interview.\nHanded over from Claude Code's skills. Apply these instructions now; supporting files are in "), "a handover leads with the description and names the directory")
  assert.ok(first.text.includes("\n\n# Grilling, project edition\n\nAsk about this repository."), "a handover carries the body")
  assert.ok(first.text.includes(`[Skill hyperframes] Installed for you at ${join(cursorRoot, "hyperframes", "SKILL.md")}. Use it now.`), "a native skill is pointed at")
  assert.ok(first.text.includes("[Skill huge from claude] Too big to carry.\nHanded over from Claude Code's skills. Read "), "an oversize body becomes a pointer")
  assert.ok(!first.text.includes("[Skill nope"), "a missing name adds nothing")
  assert.deepEqual(first.handed.sort(), [resolved[0]!.hash, resolved[1]!.hash].sort(), "the bodies carried are reported for the conversation to remember")

  const second = appendSkillReferences(draft, resolved, new Set(first.handed))
  assert.ok(second.text.includes("[Skill grilling from claude] Handed over from Claude Code's skills earlier in this conversation; apply it again now."), "a body already in the conversation is pointed back at")
  assert.ok(!second.text.includes("# Grilling, project edition"), "and is not repeated")
  assert.deepEqual(second.handed, [], "nothing new is carried")

  const none: SkillReference[] = [{ name: "nope", delivery: { kind: "missing" } }]
  assert.deepEqual(appendSkillReferences("hi $nope", none), { text: "hi $nope", handed: [] }, "all-missing leaves the text untouched")

  /* The round trip. */
  const parsed = parseSkillAppendix(first.text)
  assert.equal(parsed.body, draft)
  assert.deepEqual(
    parsed.skills,
    [
      { name: "wait-what", from: "agents" },
      { name: "grilling", from: "claude" },
      { name: "hyperframes" },
      { name: "huge", from: "claude" },
    ],
    "the transcript reads each marker back with its source"
  )
  assert.equal(stripSkillAppendix(first.text), draft)
  assert.equal(stripSkillAppendix(draft), draft, "a prompt without an appendix is untouched")
  assert.deepEqual(parseSkillAppendix("plain"), { body: "plain", skills: [] })

  /* Layered under the other appendices: skills come last and off first. */
  const layered = appendSkillReferences(
    `${draft}\n\n---\n[Referenced conversation 1] Older thread (claude)\n\nLocal transcript bundle: /tmp/x`,
    resolved
  ).text
  assert.ok(stripSkillAppendix(layered).endsWith("Local transcript bundle: /tmp/x"), "stripping skills leaves the thread appendix for its own parser")
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log("skill references ok")
