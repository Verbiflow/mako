import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { briefText } from "@mako/host/contracts/children"
import { FRONT_DOOR_GUIDANCE } from "@mako/host/contracts/agent-tools"
import { ROLE_RULE_LINES, ROLE_RULES_CHARS, roleRuleLines, type FinPolicy } from "@mako/host/contracts/fin-tuning"
import { CHANGED_LINE } from "@mako/host/conversations/control-cadence"
import { FinDefaultsStore } from "@mako/host/harnesses/fin-defaults"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * The person's standing rules for every Fin and every Apex (Settings › Fins), `npm run test:person-rules`: each saved
 * alone into the Fin policy, which keeps everything else in the file as it was; each a standing line of Mako's note
 * (`standingLines`), so a process hears it whole once and then as it changes, whoever's message starts the turn; a
 * conversation that read rules the person cleared is told they no longer apply, after a restart too; and with both
 * empty, Fin briefs and notes are byte for byte what they were; Apex routing guidance follows its own cadence.
 */
const root = mkdtempSync(join(tmpdir(), "mako-person-rules-"))
const FIN_RULES = "Run the tests you touch before you report.\nNever push to main."
const APEX_RULES = "Ask me before starting more than four Fins."
const FIN_HEAD = "The person's rules for every Fin:"
const APEX_HEAD = "The person's rules for you as an Apex:"
const FIN_NONE = "The person has no rules for every Fin now: any they gave you before no longer apply."
const APEX_NONE = "The person has no rules for you as an Apex now: any they gave you before no longer apply."
const BRIEF = { objective: "Fix the Android build.", boundaries: ["Stay out of ios/."], output: "The PR link." }

// ── The store: each role's words saved alone, and nothing else in the file dropped by any save.
{
  const file = join(root, "store", "fin-defaults.json")
  const store = new FinDefaultsStore(file)
  const rule = { id: "a", when: "Frontend", target: { harness: "claude" } }
  store.savePolicy({ rules: [rule], otherwise: { harness: "codex" } })
  store.choose("codex", { model: "gpt-6.1-sol" })
  const written = JSON.parse(readFileSync(file, "utf8"))
  // What a newer Mako keeps beside the policy (each device's Fin limit) and in it.
  writeFileSync(file, JSON.stringify({ ...written, limit: 6, policy: { ...written.policy, cloud: { atOnce: 4 } } }))
  const saved = new FinDefaultsStore(file)
  assert.deepEqual(saved.saveRoleRules("forFins", `  ${FIN_RULES}  `).policy, { rules: [rule], otherwise: { harness: "codex" }, forFins: FIN_RULES }, "trimmed, and the model rules kept")
  saved.saveRoleRules("forApexes", APEX_RULES)
  saved.savePolicy({ rules: [], otherwise: { harness: "claude" } })
  saved.use("cursor", { model: "composer-2.5" })
  const after = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(after.limit, 6, "the Fin limit a newer Mako wrote is kept")
  assert.deepEqual(after.policy.cloud, { atOnce: 4 }, "and what it wrote in the policy")
  assert.deepEqual(after.chosen, { codex: { model: "gpt-6.1-sol" } }, "the model choices are kept")
  assert.deepEqual(after.policy.forFins, FIN_RULES, "saving the model rules keeps the standing rules")
  assert.deepEqual(after.policy.forApexes, APEX_RULES)
  assert.deepEqual(saved.saveRoleRules("forFins", "   ").policy, { rules: [], otherwise: { harness: "claude" }, forApexes: APEX_RULES }, "blank is none, and only that role changes")
  assert.throws(() => saved.saveRoleRules("forApexes", "x".repeat(ROLE_RULES_CHARS + 1)), "at most the limit")
  // @ts-expect-error a role that isn't one is refused
  assert.throws(() => saved.saveRoleRules("forEveryone", "x"))
  writeFileSync(file, JSON.stringify({ version: 1, chosen: {}, used: {}, policy: { rules: [rule], otherwise: { harness: "codex" } } }))
  assert.deepEqual(new FinDefaultsStore(file).reading().policy, { rules: [rule], otherwise: { harness: "codex" } }, "a policy from before the fields parses unchanged")
  writeFileSync(file, JSON.stringify({ version: 1, chosen: {}, used: {}, policy: { rules: [rule], forFins: 7, forApexes: APEX_RULES } }))
  assert.deepEqual(new FinDefaultsStore(file).reading().policy, { rules: [rule], forApexes: APEX_RULES }, "a field this build can't read is left out, never the rest")
}

// ── The lines: one per role, under its head; the line that says they went, once a conversation read some; else none.
{
  const reader = { fin: true, apex: true, read: new Set<string>() }
  assert.deepEqual(roleRuleLines({ forFins: FIN_RULES, forApexes: APEX_RULES }, reader), { "fin-rules": `${FIN_HEAD}\n${FIN_RULES}`, "apex-rules": `${APEX_HEAD}\n${APEX_RULES}` })
  assert.deepEqual(roleRuleLines({}, reader), { "fin-rules": undefined, "apex-rules": undefined }, "nothing to say, nothing said")
  assert.deepEqual(roleRuleLines({}, { ...reader, read: new Set([ROLE_RULE_LINES.forFins, ROLE_RULE_LINES.forApexes]) }), { "fin-rules": FIN_NONE, "apex-rules": APEX_NONE }, "read and cleared: they no longer apply")
  assert.deepEqual(roleRuleLines({ forFins: FIN_RULES, forApexes: APEX_RULES }, { ...reader, fin: false, apex: false }), { "fin-rules": undefined, "apex-rules": undefined }, "each only to its role")
}

// ── Delivery, through the host's own engine and the note's own cadence.
let policy: FinPolicy = { rules: [] }
const promptsOf = (world: AgentsWorld, conversation: string) => world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => prompt.text)
const note = (text: string | undefined) => (text ? /^<mako-local-control>\n([\s\S]*?)\n<\/mako-local-control>\n\n/.exec(text)?.[1] : undefined)
const last = (world: AgentsWorld, conversation: string) => note(promptsOf(world, conversation).at(-1))

/**
 * Exact standing guidance, when due, followed by the current single-Fin roster; no role-rule line when empty. Read
 * from the prompt that carried the person's `said`: a digest of the Fin's reports can reach the Apex after it, and
 * carries no note.
 */
function apexNote(world: AgentsWorld, conversation: string, guidance: boolean, said: string): string {
  const prompt = promptsOf(world, conversation).findLast((text) => text.includes(said))
  assert.ok(prompt, `the Apex was sent "${said}"`)
  const text = note(prompt)
  assert.ok(text, `"${said}" went with Mako's note`)
  const lines = text.split("\n")
  const standing = guidance ? ["For messages from the person:", ...FRONT_DOOR_GUIDANCE] : []
  assert.deepEqual(lines.slice(0, -1), [...standing, "You're this Thread's Apex: the person writes to you, and you decide who handles it. Your Fins now:"])
  for (const line of FRONT_DOOR_GUIDANCE) assert.equal(text.split(line).length - 1, Number(guidance), "each exact routing paragraph appears only when due")
  assert.match(lines.at(-1)!, /^- fin:android · Claude · done [^\n]* · asked: Fix the Android build\.$/, "the current Fin stays in the note")
  return lines.at(-1)!
}

async function team(name: string, role?: "lead") {
  const world = new AgentsWorld({ root: join(root, name), script: () => "Done.", policy: () => policy })
  const apex = await world.apex("codex")
  const started = await world.agents.start(apex.caller, { brief: BRIEF, harness: "claude", name: "android", clientKey: "android", cwd: world.root, ...(role && { role }) })
  assert.ok(!("refused" in started) && started.conversation)
  await world.settle()
  return { world, apex, fin: started.conversation! }
}

async function tell(world: AgentsWorld, apex: { caller: Parameters<AgentsWorld["agents"]["send"]>[0] }, text: string): Promise<void> {
  const sent = await world.agents.send(apex.caller, { to: "android", text, clientKey: text })
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  // Its reports reach its Apex at the minute's budget (`WAKES_PER_MINUTE`), which these quick turns spend: not what's read here.
  await world.settle(undefined, undefined, "ignore")
}

/** Both fields empty: no role rules; routing guidance once, but a fresh roster on each person message. */
async function emptyIsUnchanged(): Promise<void> {
  policy = { rules: [] }
  const { world, apex, fin } = await team("empty")
  try {
    assert.equal(promptsOf(world, fin)[0], briefText(BRIEF, "android"), "the brief, byte for byte, with no note")
    await tell(world, apex, "Rebase on main.")
    assert.equal(last(world, fin), undefined, "no note before a Fin's next turn")
    world.say(apex.conversation, "How is it going?")
    await world.settle()
    assert.ok(apexNote(world, apex.conversation, true, "How is it going?").includes("Done."))
    const report = await world.agents.report(world.caller(fin), { clientKey: "fresh-roster", status: "done", summary: "The Android check failed; the mutation outcome is unknown." })
    assert.ok(!("refused" in report))
    await world.settle(undefined, undefined, "ignore")
    world.say(apex.conversation, "What changed?")
    await world.settle(undefined, undefined, "ignore")
    assert.ok(apexNote(world, apex.conversation, false, "What changed?").includes("The Android check failed; the mutation outcome is unknown."), "the new report reaches the roster without repeating guidance")
  } finally {
    await world.close()
  }
}

/** A Fin reads the Fin rules with its brief, a change once at its next turn, and that they went when cleared; a restart says the latest. */
async function finRules(): Promise<void> {
  policy = { rules: [], forFins: FIN_RULES }
  const { world, apex, fin } = await team("fin")
  try {
    assert.equal(promptsOf(world, fin)[0], `<mako-local-control>\n${FIN_HEAD}\n${FIN_RULES}\n</mako-local-control>\n\n${briefText(BRIEF, "android")}`, "with its brief, in Mako's note")
    await tell(world, apex, "First.")
    assert.equal(last(world, fin), undefined, "read: not again")
    policy = { rules: [], forFins: "Write a test for every fix." }
    await tell(world, apex, "Second.")
    assert.equal(last(world, fin), `${CHANGED_LINE}\n${FIN_HEAD}\nWrite a test for every fix.`, "changed: once, at a turn its Apex started")
    await tell(world, apex, "Third.")
    assert.equal(last(world, fin), undefined, "and only once")
    await world.restart()
    await tell(world, apex, "Fourth.")
    assert.equal(last(world, fin), `${FIN_HEAD}\nWrite a test for every fix.`, "a new process hears the rules it last accepted, not its brief's")
    policy = { rules: [] }
    await tell(world, apex, "Fifth.")
    assert.equal(last(world, fin), `${CHANGED_LINE}\n${FIN_NONE}`, "cleared: told they no longer apply")
    await world.restart()
    await tell(world, apex, "Sixth.")
    assert.equal(last(world, fin), FIN_NONE, "and after a restart, still told, never silence that leaves the brief's rules standing")
    world.say(apex.conversation, "Anything new?")
    await world.settle(undefined, undefined, "ignore")
    apexNote(world, apex.conversation, true, "Anything new?") // Exact guidance and roster, with no Fin-rule or rule-removal line.
  } finally {
    await world.close()
  }
}

/** Every Thread that may lead hears the Apex rules once, changed ones whoever starts its turn, and that they went when cleared. */
async function apexRules(): Promise<void> {
  policy = { rules: [], forApexes: APEX_RULES }
  const world = new AgentsWorld({ root: join(root, "apex"), script: () => "ok", policy: () => policy })
  try {
    const apex = await world.apex("codex")
    world.say(apex.conversation, "Plan the release.")
    await world.settle()
    assert.equal(promptsOf(world, apex.conversation).at(-1), `<mako-local-control>\n${APEX_HEAD}\n${APEX_RULES}\n</mako-local-control>\n\nPlan the release.`)
    world.say(apex.conversation, "And the notes.")
    await world.settle()
    assert.equal(promptsOf(world, apex.conversation).at(-1), "And the notes.", "once")
    policy = { rules: [] }
    world.say(apex.conversation, "Go.")
    await world.settle()
    assert.equal(last(world, apex.conversation), `${CHANGED_LINE}\n${APEX_NONE}`, "cleared: told they no longer apply")
  } finally {
    await world.close()
  }
  policy = { rules: [], forApexes: APEX_RULES }
  const { world: led, apex, fin } = await team("lead", "lead")
  try {
    assert.ok(note(promptsOf(led, fin)[0])!.includes(`${APEX_HEAD}\n${APEX_RULES}`), "a Fin started as an Apex reads them with its brief")
    policy = { rules: [], forApexes: "Start at most two Fins at once." }
    await tell(led, apex, "Carry on.")
    assert.equal(last(led, fin), `${CHANGED_LINE}\n${APEX_HEAD}\nStart at most two Fins at once.`, "a change reaches it on a turn its parent started")
  } finally {
    await led.close()
  }
}

try {
  await emptyIsUnchanged()
  await finRules()
  await apexRules()
  console.log("person rules: saved alone, kept with everything else, said once and on change whoever starts the turn, told when cleared and after a restart, nothing when empty")
} finally {
  rmSync(root, { recursive: true, force: true })
}
