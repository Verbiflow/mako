import assert from "node:assert/strict"
import { frontDoorNote } from "../packages/host/src/contracts/agent-tools"
import { childEntry, childState, decisionOn, decisionWords, finPullRequests, idleFor, pullKey, pullRef, ReportSchema, reportRoute, waitingWords, type ChildSpec, type ChildState, type Report, type ReportStatus, type ThreadParent, type WakeOn } from "../packages/host/src/contracts/agents"
import { askWords, childGroup, childLine, childWord, openAsk, rollup, rollupLine } from "../packages/host/src/contracts/children"
import { ChildStateSchema, type NativeAgent } from "../packages/host/src/contracts/native-agents"
import { SessionIdSchema, ThreadIdSchema } from "../packages/host/src/contracts/thread-identity"
import { decidedLine, digest, type Notice } from "../packages/host/src/conversations/agent-wakes"
import { readFinReports } from "../packages/host/src/contracts/fin-reports"

/*
 * Done, needs your decision (`npm run test:fin-decisions`): a Fin that finished with a question reads as done with
 * that decision open, on its Apex or the person, by what it said (`decides`) and how its Apex hears it (`wake`), until
 * it's answered. The matrix is status × decides × wake × answered, for `childState`, `reportRoute`, `rollup` and the
 * digest line; then the front door's words, which say the same as the digest.
 */

const CHILD = ThreadIdSchema.parse("00000000-0000-4000-8000-00000000c41d")
const APEX = ThreadIdSchema.parse("00000000-0000-4000-8000-0000000a0e00")
const SESSION = SessionIdSchema.parse("00000000-0000-4000-8000-0000000a0e01")
const AT = 1_000

function edge(asked: Pick<ChildSpec, "mode" | "wake"> = {}, closedAt?: number): ThreadParent {
  return {
    child: CHILD, parent: APEX, parentSession: SESSION, name: "merge", role: "worker", origin: "started",
    asked: { brief: { objective: "Get the PR green" }, ...asked }, op: "start:apex:merge", startedBy: { kind: "agent", session: SESSION }, createdAt: 0,
    ...(closedAt !== undefined && { closedAt }),
  }
}

function report(status: ReportStatus, extra: Partial<Report> = {}): Report {
  return {
    id: `report:${CHILD}:${status}`, child: CHILD, status, summary: "PR #371 is green: every check passed.",
    question: "Merge #371?", options: [{ label: "Merge" }, { label: "Leave open" }], recommended: 0,
    artifacts: [{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/371" }],
    ownerGeneration: 1, at: AT, ...extra,
  }
}

const WAKES: (WakeOn | undefined)[] = [undefined, "decisions", "finish", "never"]
const DECIDES: (Report["decides"])[] = [undefined, "apex", "person"]

// reportRoute: a done report's result goes where it always went, whoever decides; questions go to the person past `decisions`.
for (const wake of WAKES)
  for (const mode of [undefined, "wait"] as const)
    for (const decides of DECIDES) {
      const asked = { ...(wake && { wake }), ...(mode && { mode }) }
      assert.equal(reportRoute(asked, "done"), wake === "never" && mode !== "wait" ? "none" : "apex", `done result, wake ${wake} mode ${mode}`)
      assert.equal(reportRoute(asked, "needs-input"), (wake ?? "decisions") === "decisions" ? "apex" : "person")
      assert.equal(reportRoute(asked, "progress"), "none")
      const on = decisionOn(asked, { ...(decides && { decides }) })
      assert.equal(on, decides === "person" || (wake ?? "decisions") !== "decisions" ? "person" : "lead", `decides ${decides}, wake ${wake}`)
      assert.equal(decisionOn(asked, { for: "person" }), "person", "one its Apex left to the person is theirs")
    }
console.log("reportRoute and decisionOn: a done result routes as before; the decision is the Apex's only on decisions and when the Fin didn't say person")

// childState over status × decides × wake × answered.
for (const status of ["done", "needs-input", "blocked", "failed", "progress"] as const)
  for (const decides of DECIDES)
    for (const wake of WAKES)
      for (const answered of [false, true]) {
        const latest = report(status, decides ? { decides } : {})
        const journal = { latest, ...(answered && { answered: { by: "lead" as const, answer: "Merge", ask: latest.id, at: AT + 1 } }) }
        const state = childState(edge(wake ? { wake } : {}), { source: "live" }, journal)
        assert.ok(ChildStateSchema.safeParse(state).success, "the state crosses the wire as its schema says")
        const label = `${status} decides ${decides} wake ${wake} answered ${answered}`
        if (status === "done") {
          assert.equal(state.kind, "ended", label)
          assert.ok(state.kind === "ended" && state.outcome === "done")
          if (answered) assert.equal(state.decision, undefined, `${label}: an answer closes the decision`)
          else {
            const on = decides === "person" || (wake ?? "decisions") !== "decisions" ? "person" : "lead"
            assert.deepEqual(state.decision, { question: "Merge #371?", on, ask: { kind: "report", id: latest.id, options: [{ label: "Merge" }, { label: "Leave open" }], recommended: 0 } }, label)
            assert.equal(childGroup(state), on === "person" ? "needs" : "done", `${label}: the person's counts as needs you, the Apex's as done`)
            assert.equal(childWord(state), on === "person" ? "Done · needs you" : "Done")
            assert.equal(childLine(state), "Merge #371?")
            assert.deepEqual(openAsk(state), { question: "Merge #371?", on, ask: state.decision!.ask, done: true })
            assert.equal(askWords(openAsk(state)!), "Done · needs you: Merge #371?")
          }
        } else if (status === "blocked" || status === "needs-input") {
          assert.equal(state.kind, "blocked", `${label}: a question it waits on still blocks it`)
          assert.equal(openAsk(state)?.done, undefined)
        } else if (status === "failed") assert.deepEqual(state, { kind: "ended", outcome: "failed", reason: "PR #371 is green: every check passed." })
        else assert.equal(state.kind, "idle", label)
      }
console.log("childState: a done report's question is its open decision, on the Apex or the person, and an answer closes it")

// A later report, a later turn or a stop clears the decision; while it works on the answer its row says who answered.
{
  const decided = report("done")
  const later = childState(edge(), { source: "live" }, { latest: { ...report("done", { question: undefined }), at: AT + 5 } })
  assert.deepEqual(later, { kind: "ended", outcome: "done" }, "a report after it replaces it")
  const working = childState(edge(), { source: "live", working: true, step: "Shell gh pr merge 371" }, { latest: decided, answered: { by: "person", answer: "Merge", ask: decided.id, at: AT + 1 } })
  assert.deepEqual(working, { kind: "working", step: "Shell gh pr merge 371", answered: { by: "person", answer: "Merge" } })
  assert.equal(childLine(working), "You answered: Merge", "the person's answer, until its next state")
  assert.equal(childLine({ kind: "working", answered: { by: "lead", answer: "Merge" } }), "Apex answered: Merge")
  const progressed = childState(edge(), { source: "live", working: true }, { latest: { ...report("progress", { question: undefined }), summary: "Merging.", at: AT + 2 }, answered: { by: "person", answer: "Merge", ask: decided.id, at: AT + 1 } })
  assert.deepEqual(progressed, { kind: "working", phase: "Merging." }, "a report after the answer is past it")
  const stopped = childState(edge({}, AT + 3), { source: "live" }, { latest: decided })
  assert.equal(stopped.kind === "ended" && stopped.outcome, "stopped", "a stop after it ends it as stopped")
  const turn = childState(edge(), { source: "live", working: true }, { latest: decided })
  assert.equal(turn.kind, "working", "a turn of the Fin's own is past it")
  const entry = childEntry(edge(), { source: "live" }, { latest: decided })
  assert.equal(entry.state.kind, "completed", "its roster entry is completed: it isn't work anyone waits on")
  assert.equal(entry.child?.state?.kind === "ended" && entry.child.state.decision?.question, "Merge #371?", "and carries the decision")
}
// An answer settles the ask it names, never another by the clock: a newer question in the same millisecond stays open.
{
  const first = report("done", { id: `report:${CHILD}:first` })
  const second = report("done", { id: `report:${CHILD}:second`, question: "Merge #372?", at: AT })
  const tied = childState(edge(), { source: "live" }, { latest: second, answered: { by: "lead", answer: "Merge", ask: first.id, at: AT } })
  assert.equal(tied.kind === "ended" && tied.decision?.question, "Merge #372?", "the newer ask is open though the answer to the first has its very time")
  const earlier = childState(edge(), { source: "live" }, { latest: second, answered: { by: "lead", answer: "Merge", ask: first.id, at: AT + 10 } })
  assert.equal(earlier.kind === "ended" && earlier.decision?.question, "Merge #372?", "and so it is with the answer's clock ahead of it")
  const own = childState(edge(), { source: "live" }, { latest: second, answered: { by: "lead", answer: "Merge", ask: second.id, at: AT - 10 } })
  assert.deepEqual(own, { kind: "ended", outcome: "done" }, "its own answer settles it, whatever its clock says")
}
console.log("cleared: by a later report, a turn, a stop or an answer, whose words the working row says")
console.log("identity: an answer settles the ask it names, a newer one in the same millisecond stays open")

// rollup: the person's decisions count under needs you, the Apex's under done.
{
  const fin = (index: number, state: ChildState): NativeAgent => ({ bindingId: "mako:children", nativeId: `mako-child:${index}`, provider: "codex", title: `Fin ${index}`, state: { kind: "completed" }, observedAt: 1, child: { thread: `t-${index}`, origin: "started", state } })
  const ask = { kind: "report" as const, id: "r" }
  const counts = rollup([
    fin(0, { kind: "ended", outcome: "done", decision: { question: "Merge?", on: "person", ask } }),
    fin(1, { kind: "ended", outcome: "done", decision: { question: "Which one?", on: "lead", ask } }),
    fin(2, { kind: "ended", outcome: "done" }),
    fin(3, { kind: "blocked", on: "person", question: "Key?" }),
    fin(4, { kind: "working", answered: { by: "person", answer: "Merge" } }),
  ])
  assert.deepEqual(counts, { total: 5, needs: 2, working: 1, queued: 0, idle: 0, failed: 0, done: 2 })
  assert.equal(rollupLine(counts), "2 need you · 1 working · 2 done")
}
console.log("rollup: a done Fin whose decision is the person's needs them; one its Apex decides is done")

// The digest line, the front door and another Apex's digest say the same words.
{
  const notice = (status: ReportStatus, decision: Notice["decision"], extra: Partial<Report> = {}): Notice => ({ id: `n:${status}:${decision}`, report: report(status, extra), label: "\"merge\" (Codex)", fin: { name: "merge", harness: "codex" }, from: SESSION, ...(decision && { decision }) })
  const words = "done; decide: Merge #371? (Merge · Leave open, recommends Merge)"
  assert.equal(decisionWords({ question: "Merge #371?", on: "lead", ask: { kind: "report", id: "r", options: [{ label: "Merge" }, { label: "Leave open" }], recommended: 0 } }), words)
  assert.equal(decidedLine(report("done"), "lead"), `${words} (+37 chars: agents_read)`)
  const lead = digest([notice("done", "lead")], "0 working, 1 ended.")
  assert.match(lead, new RegExp(`1 needs a decision:\\n  • "merge" \\(Codex\\) ${escape(words)} \\(\\+37 chars: agents_read\\)\\n    pull-request: https://git\\.example\\.com/acme/app/pull/371\\n  agents_answer answers each`))
  assert.doesNotMatch(lead, /finished:/, "a decision isn't filed under finished")
  const person = digest([notice("done", "person", { decides: "person" })], "0 working, 1 ended.")
  assert.match(person, /1 waits on the person:\n {2}• "merge" \(Codex\) done; the person decides: Merge #371\? \(Merge · Leave open, recommends Merge\) \(\+37 chars: agents_read\)\. It's the person's: they answer it from their Inbox\. Don't answer it\./)
  const cardOf = (text: string) => readFinReports(text).reports[0]
  assert.deepEqual(cardOf(lead) && { status: cardOf(lead)!.status, decides: cardOf(lead)!.decides, line: cardOf(lead)!.line, options: cardOf(lead)!.options?.length }, { status: "done", decides: "lead", line: "Merge #371?", options: 2 }, "the wake's card says who decides, for the report's message")
  assert.equal(cardOf(person)?.decides, "person", "and the person's reads as finished · needs you from data alone")
  const escalated = digest([notice("done", "person", { for: "person", told: true })], "0 working, 1 ended.")
  assert.match(escalated, /Mako asked the person too, since you didn't answer it in time: they can answer it from their Inbox\. You may still answer it with agents_answer/)
  const plain = digest([notice("done", undefined, { question: undefined, options: undefined, recommended: undefined })], "0 working, 1 ended.")
  assert.match(plain, /1 finished:\n {2}• "merge" \(Codex\) done: PR #371 is green: every check passed\./, "a done report without a question is a result, as before")
  const waited = digest([{ ...notice("done", "lead"), settledOnly: true }], "0 working, 1 ended.")
  assert.match(waited, /The result you waited for:[\s\S]*\n {4}done; decide: Merge #371\?/, "a result waited for carries its decision beneath it")

  const state = childState(edge(), { source: "live" }, { latest: report("done") })
  const note = frontDoorNote([
    { name: "docs", harness: "Claude", state: { kind: "ended", outcome: "done" }, topic: "Docs", report: { status: "done", line: "Docs updated.", at: AT } },
    { name: "merge", harness: "Codex", state, topic: "Get the PR green" },
  ], AT + 120_000).join("\n")
  assert.match(note, new RegExp(`- fin:merge · Codex · ${escape(words)} · asked: Get the PR green\\n- fin:docs`), "the front door lists it first, in the digest's words")
}
console.log("digest, front door: \"done; decide: Merge #371? (Merge · Leave open, recommends Merge)\" in each")

// waitingOn: typed items or a few words, carried on a blocked state and an open decision, said in every line.
{
  const waitingOn = [{ kind: "pull-request" as const, ref: "https://git.example.com/acme/app/pull/412", until: "checks" as const }, { kind: "person" as const, what: "merge" }, { kind: "other" as const, text: "the staging deploy" }]
  assert.equal(waitingWords(waitingOn), "waiting on #412 checks, the person to merge, the staging deploy (no automatic wake)")
  assert.equal(waitingWords([{ kind: "pull-request", ref: "#7" }]), "waiting on #7")
  assert.equal(
    waitingWords([{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/7", until: "checks" }, { kind: "pull-request", ref: "https://git.example.com/acme/api/pull/7", until: "review" }]),
    "waiting on acme/app#7 checks, acme/api#7 review",
    "two repositories' #7 are told apart by their repository",
  )
  assert.equal(waitingWords([]), undefined)
  assert.ok(ReportSchema.safeParse(report("done", { waitingOn })).success, "a report carries them")
  assert.ok(!ReportSchema.safeParse({ ...report("done"), waitingOn: [{ kind: "pull-request", ref: "#1", until: "deploy" }] }).success, "an until it doesn't know is refused")
  const decided = childState(edge(), { source: "live" }, { latest: report("done", { waitingOn }) })
  assert.deepEqual(decided.kind === "ended" && decided.waitingOn, waitingOn, "an open decision carries what it waits on")
  assert.ok(ChildStateSchema.safeParse(decided).success)
  const blocked = childState(edge(), { source: "live" }, { latest: report("needs-input", { waitingOn }) })
  assert.deepEqual(blocked.kind === "blocked" && blocked.waitingOn, waitingOn, "so does a question it waits on")
  const answered = childState(edge(), { source: "live" }, { latest: report("done", { waitingOn }), answered: { by: "lead", answer: "Merge", ask: report("done").id, at: AT + 1 } })
  assert.deepEqual(answered, { kind: "ended", outcome: "done" }, "an answered decision waits on nothing")
  const plain = childState(edge(), { source: "live" }, { latest: report("done", { question: undefined, waitingOn }) })
  assert.deepEqual(plain, { kind: "ended", outcome: "done" }, "a result without a question waits on nothing")
  const line = decidedLine(report("done", { waitingOn: [waitingOn[0]!] }), "lead")
  assert.equal(line, "done; decide: Merge #371? (Merge · Leave open, recommends Merge) · waiting on #412 checks (+37 chars: agents_read)")
  const wake = digest([{ id: "n", report: report("needs-input", { waitingOn: [waitingOn[0]!] }), label: "\"merge\" (Codex)", fin: { name: "merge", harness: "codex" }, from: SESSION }], "1 blocked.")
  assert.match(wake, /is asking: Merge #371\? · waiting on #412 checks\n/)
  assert.equal(readFinReports(wake).reports[0]?.waiting, "waiting on #412 checks", "its card carries the waiting words")
  const note = frontDoorNote([{ name: "merge", harness: "Codex", state: decided, topic: "Get the PR green" }], AT).join("\n")
  assert.match(note, /- fin:merge · Codex · done; decide: Merge #371\? \(Merge · Leave open, recommends Merge\) · waiting on #412 checks, the person to merge, the staging deploy \(no automatic wake\) · asked:/)
}
console.log("waitingOn: typed or in words, on blocked and open decisions, \"waiting on #412 checks\" in the digest and front door")

// openPRs and idleFor: from what the host holds, never a read of GitHub.
{
  const held = [
    { number: 412, url: "https://git.example.com/acme/app/pull/412", state: "open" as const },
    { number: 400, url: "https://git.example.com/acme/app/pull/400", state: "merged" as const },
    { number: 405, url: "https://git.example.com/acme/app/pull/405", state: "draft" as const },
  ]
  const reports = [
    { artifacts: [{ kind: "pull-request" as const, ref: "#371" }, { kind: "pull-request" as const, ref: "https://git.example.com/acme/app/pull/400" }] },
    { artifacts: [{ kind: "pull-request" as const, ref: "https://git.example.com/acme/app/pull/380" }, { kind: "branch" as const, ref: "fix/swipe" }, { kind: "pull-request" as const, ref: "https://git.example.com/acme/app/pull/412" }] },
  ]
  assert.deepEqual(finPullRequests(held, reports), [
    { repository: "acme/app", number: 412, url: "https://git.example.com/acme/app/pull/412", state: "open" },
    { repository: "acme/app", number: 405, url: "https://git.example.com/acme/app/pull/405", state: "draft" },
    { repository: "acme/app", number: 380, url: "https://git.example.com/acme/app/pull/380", state: "reported" },
    { repository: "acme/app", number: 371, state: "reported" },
  ], "its branch's open ones, then those its reports name that GitHub didn't say are merged, newest first, once each; a bare #371 is its one repository's")
  assert.deepEqual(finPullRequests([], []), [])

  // A pull request is its repository's and number, never its number alone: a Thread can hold several repositories.
  const two = finPullRequests(
    [{ number: 7, url: "https://git.example.com/acme/app/pull/7", state: "closed" }, { number: 9, url: "https://git.example.com/acme/api/pull/9", state: "open" }],
    [{ artifacts: [{ kind: "pull-request", ref: "https://git.example.com/acme/api/pull/7" }, { kind: "pull-request", ref: "https://git.example.com/acme/web/pull/7" }, { kind: "pull-request", ref: "#7" }, { kind: "pull-request", ref: "acme/app#7" }] }],
  )
  assert.deepEqual(two, [
    { repository: "acme/api", number: 9, url: "https://git.example.com/acme/api/pull/9", state: "open" },
    { repository: "acme/api", number: 7, url: "https://git.example.com/acme/api/pull/7", state: "reported" },
    { repository: "acme/web", number: 7, url: "https://git.example.com/acme/web/pull/7", state: "reported" },
    { number: 7, state: "reported" },
  ], "a closed #7 of one repository hides no other's #7, two repositories' #7 stay two, acme/app#7 is the closed one, and a bare #7 among several repositories stays unqualified")
  assert.deepEqual(pullRef("https://git.example.com/Acme/App/pull/12/files"), { repository: "acme/app", number: 12, url: "https://git.example.com/Acme/App/pull/12/files" })
  assert.deepEqual(pullRef("acme/app#12"), { repository: "acme/app", number: 12 })
  assert.deepEqual(pullRef("#12"), { number: 12 })
  assert.equal(pullRef("the release branch"), undefined)
  assert.equal(pullKey({ repository: "acme/app", number: 7 }) === pullKey({ repository: "acme/api", number: 7 }), false)
  assert.equal(idleFor({ kind: "working" }, 0, 90_000), undefined, "a working Fin isn't idle")
  assert.equal(idleFor({ kind: "queued", reason: "tree-running", ahead: 0 }, 0, 90_000), undefined)
  assert.equal(idleFor({ kind: "idle" }, 1_000, 91_900), 90)
  assert.equal(idleFor({ kind: "ended", outcome: "done" }, 5_000, 4_000), 0, "a clock behind the activity says 0")
}
console.log("openPRs and idleFor: held pull requests and reported ones, seconds idle only while not working")

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

console.log("fin decisions: ok")
