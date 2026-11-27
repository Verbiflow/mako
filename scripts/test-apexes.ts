import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Actor } from "@mako/host/contracts/thread-identity"
import {
  PLAN_SECTIONS,
  RULES_BUDGET_CHARS,
  apexDigest,
  apexNoteLine,
  asksNobody,
  planQuestion,
  checkPlanItem,
  digestNote,
  needsChanged,
  parsePlan,
  planText,
  routeFor,
  ruleLayerLines,
  ruleParts,
  seedPlan,
} from "@mako/host/contracts/apexes"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { CHILDREN_BINDING } from "@mako/host/contracts/native-agents"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveStartOptions } from "@mako/host/contracts/live-conversations"
import { Apexes, type ApexLive, type ApexesDeps } from "@mako/host/conversations/apexes"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { HELD_BY_TABLE, ThreadStore, type JournalFacts } from "@mako/host/threads/store"
import { claudeRoutedCall } from "@mako/host/harnesses/claude/routing"
import { callGateAnswer } from "@mako/host/harnesses/call-gate"

/**
 * Deliberate Apexes (`contracts/apexes.ts`, `conversations/apexes.ts`): the plan read and written back, the digest
 * built from typed state and resolving as that state moves, the layers fitted to their budget, routing a message with
 * no owner, and the service on a real Thread store: a new Apex made, a Thread promoted and demoted, Threads gathered
 * with every refusal in Mako's words, a Fin handed to another Apex, the plan, the rules and the lessons.
 */
const root = mkdtempSync(join(tmpdir(), "mako-apexes-"))
const migration: Actor = { kind: "service", name: "migration" }
let clock = 1_000_000
const now = () => (clock += 1_000)

/** The accepted branch of an answer: a refusal fails the test with what it said. */
function accepted<T extends object>(answer: T): Exclude<T, { refused: string }> {
  if ("refused" in answer) throw new Error(`refused: ${JSON.stringify(answer)}`)
  // SAFETY: an answer without `refused` is its union's accepted branch.
  return answer as Exclude<T, { refused: string }>
}

function fin(thread: string, name: string, state: NonNullable<NativeAgent["child"]>["state"], at = clock): NativeAgent {
  // SAFETY: a Fin's entry as `childEntry` makes one, with only the fields the digest reads.
  return {
    bindingId: CHILDREN_BINDING,
    provider: "claude",
    nativeId: `fin-${thread}`,
    kind: "subagent",
    title: name,
    state: { kind: "working" },
    observedAt: at,
    since: at,
    child: { thread, name, origin: "started", state },
  } as NativeAgent
}

try {
  // ── The plan ──
  const seeded = seedPlan("Mobile", "The iOS and Android apps")
  const plan = parsePlan(seeded)
  assert.equal(plan.title, "Mobile")
  assert.equal(plan.intro, "The iOS and Android apps")
  assert.deepEqual(plan.sections.map((section) => section.name), [...PLAN_SECTIONS], "a new plan has every section, in order")
  const written = planText({
    title: "Mobile",
    sections: [
      { name: "Now", items: [{ done: false, text: "fin:login fix the login crash", fin: "login" }, { done: true, text: "fin:icons new icons" }] },
      { name: "Waiting on you", items: [{ done: false, text: "Merge word for acme/app#12" }] },
      { name: "Files", items: [{ done: false, text: "reports/login.md" }] },
    ],
  })
  const round = parsePlan(written)
  assert.equal(round.sections[0]!.items[0]!.fin, "login", "an item names its Fin")
  assert.equal(round.sections[0]!.items[1]!.done, true)
  assert.equal(round.sections.find((section) => section.name === "Files")!.items[0]!.text, "reports/login.md", "Files are plain bullets")
  assert.equal(planText(round), written, "a plan reads back to the same text")
  const checked = checkPlanItem(written, "Waiting on you", 0, true)!
  assert.equal(parsePlan(checked).sections.find((section) => section.name === "Waiting on you")!.items[0]!.done, true)
  assert.equal(checkPlanItem(written, "Now", 9, true), undefined, "an item that isn't there isn't checked")

  // ── The digest ──
  const asking = fin(randomUUID(), "login", { kind: "blocked", on: "person", question: "Ship the fix behind a flag?" })
  const working = fin(randomUUID(), "icons", { kind: "working", step: "Edit Icons.swift" })
  const done = fin(randomUUID(), "docs", { kind: "ended", outcome: "done" }, clock + 50)
  const apexAsk = fin(randomUUID(), "tests", { kind: "blocked", on: "lead", question: "Which simulator?" })
  const digest = apexDigest([asking, working, done, apexAsk], written, undefined)
  assert.deepEqual(digest.needs.map((item) => item.line), ["Ship the fix behind a flag?", "Merge word for acme/app#12"], "Needs you: the person's asks, then the plan's waiting lines")
  assert.deepEqual(digest.new.map((item) => item.fin?.name), ["docs"])
  assert.deepEqual(digest.progress.map((item) => item.fin?.name).sort(), ["icons", "tests"], "a question for the Apex is still in progress for the person")
  const answered = apexDigest([{ ...asking, child: { ...asking.child!, state: { kind: "working" } } }, working, done], checked, clock + 100)
  assert.deepEqual(answered.needs, [], "answered and checked, nothing needs the person: the digest can't drift")
  assert.deepEqual(answered.new, [], "what finished before the person read it is no longer new")
  assert.ok(needsChanged([], digest))
  assert.ok(!needsChanged(digest.needs.map((item) => item.key), digest), "the same Needs you hasn't changed")
  assert.match(digestNote(digest, false), /unchanged since your last turn[\s\S]*Don't message the person/)
  assert.match(digestNote(digest, true), /changed since your last turn[\s\S]*Tell the person/)

  // A plan line that asks is a question with its offered answers; one that doesn't is the person's to-do.
  assert.deepEqual(planQuestion("Include usage examples? [Yes | No]"), { question: "Include usage examples?", options: ["Yes", "No"] })
  assert.equal(planQuestion("Merge word for acme/app#12"), undefined)
  const asks = apexDigest([], "## Waiting on you\n\n- [ ] Ship on Friday? [Yes | Wait]\n- [ ] Rotate the staging key\n", undefined)
  assert.deepEqual(asks.needs.map((item) => [item.kind, item.line, item.options, item.planAt]), [
    ["question", "Ship on Friday?", ["Yes", "Wait"], { section: "Waiting on you", index: 0 }],
    ["plan", "Rotate the staging key", undefined, { section: "Waiting on you", index: 1 }],
  ])
  assert.ok(asksNobody("apex", { action: "plan_write" }) && asksNobody("apex", { action: "list" }) && asksNobody("memory_save", {}), "an Apex's bookkeeping asks nobody")
  // Claude's PreToolUse answer lets it past the prompt; any other harness's hook reads the same answer.
  // SAFETY: claudeRoutedCall reads only the event name, tool name and tool input of a PreToolUse payload, which this holds.
  const pre = (tool: string, action: string) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { action }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "/" }) as never
  assert.equal(claudeRoutedCall({ teams: false, conversation: "c" }, pre("mcp__mako__apex", "plan_write"))?.hookSpecificOutput?.hookEventName, "PreToolUse")
  assert.equal(claudeRoutedCall({ teams: false, conversation: "c" }, pre("mcp__mako__apex", "create")), undefined, "creating an Apex goes to the person's approval as before")
  // SAFETY: the gate reads only the call's folder for a bookkeeping call it allows before any policy.
  assert.deepEqual(callGateAnswer("pre", { tool_name: "mcp__mako__memory_save", tool_input: {} }, { folder: "/" } as never, "c"), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })
  assert.ok(!asksNobody("apex", { action: "create" }) && !asksNobody("apex", { action: "gather" }) && !asksNobody("agents_start", {}), "making Apexes and moving Threads still ask")
  assert.ok(asksNobody("agents_report", {}) && asksNobody("agents_send", { to: "fin:math" }) && !asksNobody("agents_send", { to: "apex:mako-7f3k" }), "a tree's own reports and messages ask nobody; a message to another Thread asks")

  // ── Layers ──
  const big = "x".repeat(RULES_BUDGET_CHARS)
  const parts = ruleParts({ you: big, folder: "Use pnpm.", folderName: "mako", memories: [], apex: { name: "Mobile", rules: "Never merge.", finRules: "Open PRs as drafts." }, as: "apex" })
  assert.deepEqual(parts.map((part) => part.layer), ["you", "you-folder", "folder", "apex"], "an Apex reads its own rules, not its Fins'")
  assert.equal(parts.find((part) => part.layer === "apex")!.fit, undefined, "the most specific keep their room")
  assert.equal(parts.find((part) => part.layer === "you")!.fit, "cut", "the most general is cut to fit")
  assert.ok(parts.reduce((sum, part) => sum + part.sent, 0) <= RULES_BUDGET_CHARS)
  const finParts = ruleParts({ memories: [{ id: "m", scope: "folder", folder: "/x", topic: "tests", lesson: "Run npm test before a PR", savedAt: 1, confirmedAt: Date.UTC(2026, 10, 26) }], folderName: "x", apex: { name: "Mobile", rules: "secret", finRules: "Open PRs as drafts." }, as: "fin" })
  assert.deepEqual(finParts.map((part) => part.layer), ["you", "you-folder", "folder", "apex-fins"], "a Fin reads its Apex's Fin rules, never the Apex's own")
  const lines = ruleLayerLines(finParts, new Set(["rules:you"]))
  assert.match(lines["rules:folder"]!, /Remembered:\n- tests: Run npm test before a PR \(confirmed 2026-11-26\)/)
  assert.match(lines["rules:you"]!, /none now/, "a layer read before and now empty says so once")
  assert.equal(lines["rules:you-folder"], undefined, "a layer never read and empty adds nothing")

  // ── Routing ──
  const apexes = [
    { thread: "a", name: "Mobile", purpose: "The iOS and Android apps, TestFlight builds", folder: "/m" },
    { thread: "b", name: "Docs", purpose: "Public docs and the API reference", folder: "/m" },
    { thread: "c", name: "Release", purpose: "Release trains and the changelog", folder: "/other" },
  ]
  const routed = routeFor("the android build crashes on launch", "/m", apexes)
  assert.equal(routed?.kind === "one" ? routed.apex.name : routed, "Mobile")
  assert.equal(routeFor("update the changelog", "/m", apexes), undefined, "an Apex in another folder isn't suggested")
  assert.equal(routeFor("mobile docs for the api", "/m", apexes)?.kind, "two", "two that fit about as well: ask which")
  assert.equal(routeFor("hello there", "/m", apexes), undefined)

  // ── The service on a real store ──
  const store = new ThreadStore(join(root, "threads.sqlite"), { now })
  assert.equal(HELD_BY_TABLE.get("apexes"), "neither")
  const folder = join(root, "app")
  const elsewhere = join(root, "other")
  mkdirSync(folder)
  mkdirSync(elsewhere)
  type Session = { cwd: string; harness: string; title?: string; modes: { id: string; access?: "auto" | "full" | "edits" }[]; launchMode?: string; currentMode?: string }
  const sessions = new Map<string, Session>()
  const submitted: { conversation: string; text: string; actor?: Actor }[] = []
  const events: HostEvent[] = []
  const archived = new Set<string>()
  const conversationOf = new Map<string, string>()
  function thread(harness: string, cwd: string, title: string, access: "auto" | "full" = "auto") {
    const facts: JournalFacts = { conversationId: randomUUID(), createdAt: clock++, harness, bindings: [{ provider: harness, nativeId: randomUUID(), path: `/${harness}/${randomUUID()}` }] }
    const placed = store.registerJournal(facts, migration)
    store.keepThreadTitle(placed.thread, title)
    sessions.set(facts.conversationId, { cwd, harness, title, modes: [{ id: "auto", access: "auto" }, { id: "full", access: "full" }], launchMode: access, currentMode: access })
    conversationOf.set(placed.thread, facts.conversationId)
    return { thread: String(placed.thread), conversation: facts.conversationId }
  }
  let fins: NativeAgent[] = []
  const deps: ApexesDeps = {
    store: () => store,
    live: {
      // SAFETY: the service reads only cwd, harness, title and the access fields of a session, which these hold.
      session: (id: string) => sessions.get(id) as never,
      // SAFETY: the service reads only a summary's session ID and title.
      listed: () => [...sessions.keys()].map((id) => ({ session: { id, title: sessions.get(id)!.title } }) as never),
      submit: (...args: Parameters<ApexLive["submit"]>) => {
        const [conversation, , text, , , , , actor] = args
        submitted.push({ conversation, text, ...(actor && { actor }) })
      },
      held: () => undefined,
    },
    agents: () => ({
      roster: () => fins,
      isApex: () => false,
      conversationFor: (thread: string) => conversationOf.get(thread),
      membersChanged: () => {},
    }),
    startLive: async (harness: string, cwd: string, options: LiveStartOptions) => {
      const facts: JournalFacts = { conversationId: options.conversationId, createdAt: clock++, harness, bindings: [{ provider: harness, nativeId: randomUUID(), path: `/${harness}/${randomUUID()}` }] }
      const placed = store.registerJournal(facts, migration)
      sessions.set(options.conversationId, { cwd, harness, ...(options.title && { title: options.title }), modes: [{ id: "auto", access: "auto" }], launchMode: "auto", currentMode: "auto" })
      conversationOf.set(placed.thread, options.conversationId)
      if (options.apex) service.made(placed.thread, options.apex)
      if (options.initialRequest) submitted.push({ conversation: options.conversationId, text: options.initialRequest.text })
    },
    archived: (conversation: string) => archived.has(conversation),
    userRoot: join(root, "user"),
    emit: (event) => events.push(event),
    now,
  }
  const service = new Apexes(deps)

  // A new Apex: its profile, its title and its plan, before it runs; a repeat of the key is the same Apex.
  const created = await service.create({ name: "Mobile", purpose: "The iOS and Android apps", cwd: folder, harness: "claude", clientKey: "k1" }, "person")
  const mobile = accepted(created)
  assert.equal(store.apex(mobile.thread)?.name, "Mobile")
  assert.equal(store.thread(ThreadIdSchema.parse(mobile.thread))?.title, "Mobile", "its Thread is named for it")
  assert.equal(readFileSync(join(root, "user", "apexes", mobile.thread, "PLAN.md"), "utf8"), seedPlan("Mobile", "The iOS and Android apps"))
  assert.equal(submitted.length, 0, "with no first message it waits for the person's")
  const again = await service.create({ name: "Mobile", cwd: folder, harness: "claude", clientKey: "k1" }, "person")
  assert.equal(accepted(again).deduped, true)
  assert.equal(store.apexes().length, 1)
  const long = await service.create({ name: "x".repeat(10), purpose: "y".repeat(141), cwd: folder, harness: "claude", clientKey: "k2" }, "person")
  assert.ok("refused" in long && /at most 140/.test(long.why))
  assert.ok(events.some((event) => event.type === "apexes"))

  // Its first turn: it's told it's new and to write its purpose into its rules and plan, and what needs the person.
  const first = service.turnLines(mobile.conversation)
  assert.match(first[0]!, /You're new/)
  assert.match(first.at(-1)!, /Nothing needs the person now/)
  const standing = service.standing(mobile.conversation, new Set())
  assert.match(standing["apex-role"]!, /You're Mobile, an Apex the person keeps for: The iOS and Android apps/)

  // Its plan and rules, through the tools.
  const caller = { kind: "agent" as const, session: store.journalPlacement(mobile.conversation)!.session }
  const wrote = service.planAct(caller, { action: "write", text: written, clientKey: "p" })
  assert.equal(accepted(wrote).outcome, "written")
  const edited = accepted(service.planAct(caller, { action: "edit", old: "new icons", new: "the new icon set", clientKey: "e" }))
  assert.ok(edited.outcome === "edited" && edited.replacements === 1)
  assert.equal(accepted(service.rulesAct(caller, { action: "write", layer: "apex", text: "Never merge without a word.", clientKey: "r" })).outcome, "written")
  assert.equal(accepted(service.rulesAct(caller, { action: "write", layer: "fins", text: "Open PRs as drafts.", clientKey: "f" })).outcome, "written")
  const after = service.turnLines(mobile.conversation)
  assert.ok(!after.some((line) => line.includes("You're new")), "once it wrote them, it isn't new")
  assert.match(after.join("\n"), /the new icon set/, "its plan is in its note at every turn")
  assert.match(after.at(-1)!, /Needs the person now \(changed since your last turn\):\n- Merge word/)
  assert.match(service.turnLines(mobile.conversation).at(-1)!, /unchanged since your last turn/, "the next turn hears it didn't change")
  const read = accepted(service.rulesAct(caller, { clientKey: "read" }))
  assert.ok(read.outcome === "read" && read.apex.some((part) => part.text === "Never merge without a word.") && !read.fins.some((part) => part.text.includes("Never merge")))

  // A question in its plan is answered, not ticked: the line is checked with the answer, which reaches the Apex as the person's words.
  accepted(service.planAct(caller, { action: "edit", old: "## Waiting on you\n\n", new: "## Waiting on you\n\n- [ ] Ship the fix behind a flag? [Flag | Straight]\n", clientKey: "q" }))
  const before = submitted.length
  const question = service.digest(mobile.conversation, store.apex(mobile.thread)!).needs.find((item) => item.kind === "question")!
  assert.deepEqual(question.options, ["Flag", "Straight"])
  accepted(service.answerPlan(mobile.thread, question.planAt!.section, question.planAt!.index, "Flag"))
  assert.equal(submitted.length, before + 1)
  assert.equal(submitted.at(-1)!.text, "About “Ship the fix behind a flag?”: Flag")
  assert.equal(submitted.at(-1)!.actor, undefined, "the person's own words")
  assert.ok(!service.digest(mobile.conversation, store.apex(mobile.thread)!).needs.some((item) => item.kind === "question"), "answered, it leaves Needs you")
  assert.match(service.plan(mobile.thread).text, /- \[x\] Ship the fix behind a flag\? You: Flag/)

  // A lesson, saved twice under one topic, is one lesson confirmed again.
  const saved = service.memoryAct(caller, { scope: "folder", topic: "Tests", lesson: "Run npm test first.", clientKey: "m1" })
  assert.equal(accepted(saved).outcome, "saved")
  const resaved = service.memoryAct(caller, { scope: "folder", topic: "tests", lesson: "Run npm test -w app first.", clientKey: "m2" })
  assert.equal(accepted(resaved).replaced, true)
  assert.equal(service.personLayers(folder).memories.length, 1)
  assert.match(service.standing(mobile.conversation, new Set())["rules:folder"]!, /Run npm test -w app first/)

  // Gathering: one moves in; every refusal reads in Mako's words.
  const plain = thread("codex", folder, "Fix the login crash")
  const wide = thread("claude", folder, "Refresh icons", "full")
  const far = thread("claude", elsewhere, "Other folder work")
  const gone = thread("claude", folder, "Old spike")
  archived.add(gone.conversation)
  const docs = accepted(await service.create({ name: "Docs", cwd: folder, harness: "claude", clientKey: "d" }, "person"))
  const gathered = await service.gather(mobile.thread, [plain.thread, wide.thread, far.thread, gone.thread, docs.thread, mobile.thread, "no such thread"], false, "person")
  const result = accepted(gathered)
  assert.deepEqual(result.moved.map((each) => each.thread), [plain.thread])
  assert.equal(store.edges().of(plain.thread)?.origin, "attached")
  assert.deepEqual(result.stayed.map((each) => each.refused), ["access-wider", "other-folder", "archived", "is-apex", "self", "not-found"])
  const words = Object.fromEntries(result.stayed.map((each) => [each.refused, each.why]))
  assert.equal(words["access-wider"], "“Refresh icons” runs on Full access, more than Mobile's Auto. Moving it in lowers it to Auto.")
  assert.equal(words["other-folder"], "“Other folder work” works in other, and Mobile's Fins stay in app.")
  assert.equal(words.archived, "“Old spike” is archived. Restore it first, then move it in.")
  assert.equal(words["is-apex"], "“Docs” is an Apex itself. An Apex doesn't work for another: message it instead.")
  assert.ok(result.stayed.find((each) => each.refused === "access-wider")?.confirmable)
  assert.match(submitted.at(-1)!.text, /fin:fix-login-crash \(“Fix the login crash”\) joined your Shiver/, "the Apex hears who joined, as Mako's note")
  assert.equal(submitted.at(-1)!.actor?.kind, "service")
  assert.equal(apexNoteLine(submitted.at(-1)!.text), "Fix the login crash joined the Shiver", "the person reads it as a line")
  const confirmed = accepted(await service.gather(mobile.thread, [wide.thread], true, "person"))
  assert.equal(confirmed.moved.length, 1, "confirmed, it moves in at the Apex's access")
  assert.equal(store.edges().of(wide.thread)?.asked.access, "auto")
  const twice = accepted(await service.gather(docs.thread, [plain.thread], false, "person"))
  assert.equal(twice.stayed[0]!.why, "“Fix the login crash” already works for Mobile. A Thread works for one Apex: hand it over from there.")

  // Handed to another Apex: a move.
  const handed = await service.hand(mobile.thread, plain.thread, "Docs", false)
  assert.ok(!("refused" in handed))
  assert.equal(store.edges().of(plain.thread)?.parent, docs.thread)

  // Promote and demote: a Thread made an Apex keeps its title; demoted, the Threads moved in are their own again.
  const promoted = service.promote(far.conversation, { purpose: "Other things" }, "person")
  assert.ok(!("refused" in promoted))
  assert.equal(store.apex(far.thread)?.name, "Other folder work")
  assert.equal(store.apex(far.thread)?.from, "thread")
  const demoted = service.demote(mobile.thread)
  assert.deepEqual(accepted(demoted).released, [wide.thread])
  assert.equal(store.edges().of(wide.thread), undefined, "a Thread moved in goes back to being its own")
  assert.equal(store.apex(mobile.thread), undefined)
  assert.ok(existsSync(join(root, "user", "apexes", mobile.thread, "PLAN.md")), "its files stay")
  assert.equal(service.turnLines(mobile.conversation).length, 0, "a Thread again, it reads no plan")
  assert.match(service.standing(mobile.conversation, new Set(["apex-role"]))["apex-role"]!, /no longer a deliberate Apex/)

  // A reopened store keeps the profiles.
  store.close()
  const reopened = new ThreadStore(join(root, "threads.sqlite"), { now })
  assert.deepEqual(reopened.apexes().map((apex) => apex.name).sort(), ["Docs", "Other folder work"])
  reopened.close()
  console.log("apexes: plan, digest, layers, routing, create, promote, demote, gather, hand, rules and lessons hold")
} finally {
  rmSync(root, { recursive: true, force: true })
}
