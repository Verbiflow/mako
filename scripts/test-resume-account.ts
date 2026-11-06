import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkoutSince } from "@mako/host/base/checkout-since"
import { resumeAccountLine, resumeAccountText, savedResumeAccount } from "@mako/host/contracts/resume-account"
import { RunCallLog, resumeWords, type StreamedCall } from "@mako/host/harnesses/cursor/sdk/resumed-calls"
import { continuedFrom, responseSections, toExchanges, turnRequest } from "../src/lib/exchanges.ts"
import { stillDrawn } from "../src/lib/turn-fold.ts"
import type { ChatMessage } from "../src/lib/types.ts"

/**
 * A Cursor run whose stream breaks is resumed by the SDK from the last
 * checkpoint the backend saved, which can be older than calls the client
 * already ran. Twice on 2026-11-03 the resumed model couldn't see its own
 * work: it redid an edit under other names, leaving the call site its cut-off
 * edit would have fixed broken, and it disowned a commit and push it had made
 * in a call whose result never came back. Both are replayed here as their
 * streams ran: the words the retry sends name each call after the checkpoint
 * (its tool, input, whether it finished, its result) and what moved in the
 * checkout since, and the Thread draws them as one quiet line, live and saved.
 */
const root = mkdtempSync(join(tmpdir(), "mako-resume-account-"))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fin", GIT_AUTHOR_EMAIL: "fin@example.invalid", GIT_COMMITTER_NAME: "Fin", GIT_COMMITTER_EMAIL: "fin@example.invalid" } }).trim()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Past the next whole second: the reflog keeps seconds, so setup in the second of `since` would read as after it. */
const nextSecond = () => pause(1_050 - (Date.now() % 1_000))

/** A project folder of one repository, `mako`, on branch `mako/fin` with its first commit pushed to `origin`. */
function project(name: string, files: Record<string, string>) {
  const checkout = join(root, name)
  const repository = join(checkout, "mako")
  const remote = join(root, `${name}-origin.git`)
  mkdirSync(repository, { recursive: true })
  git(root, "init", "-q", "--bare", remote)
  git(repository, "init", "-q", "-b", "mako/fin")
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repository, path, ".."), { recursive: true })
    writeFileSync(join(repository, path), content)
  }
  git(repository, "add", "-A")
  git(repository, "commit", "-q", "-m", "Start")
  git(repository, "remote", "add", "origin", remote)
  git(repository, "push", "-q", "origin", "HEAD")
  return { checkout, repository }
}

interface Diff {
  status: string
  value: { linesAdded: number; linesRemoved: number; diffString: string }
}
const call = (call_id: string, name: string, status: string, args: Record<string, string>, result?: Diff): StreamedCall => ({ call_id, name, status, args, ...result && { result } })

try {
  // host-stall-fix, 10:51: four edits in one step; the fourth never completed
  // before the server error, and the SDK resumed from the checkpoint before them.
  {
    const evidence = "packages/host/src/attribution/evidence.ts"
    const { checkout, repository } = project("cut-off-edit", { [evidence]: "touch(session, call, extents)\n" })
    await nextSecond()
    const since = Date.now()
    await pause(20)
    writeFileSync(join(repository, evidence), "touch(session, moved, extents)\n")
    const path = join(checkout, "mako", evidence)
    const diff = (removed: string, added: string): Diff => ({ status: "success", value: { linesAdded: 1, linesRemoved: 1, diffString: `--- a/${evidence}\n+++ b/${evidence}\n-${removed}\n+${added}` } })
    const calls = new RunCallLog()
    for (const message of [
      call("toolu_01PmCh", "edit", "running", { path }),
      call("toolu_01PmCh", "edit", "running", { path }),
      call("toolu_01PmCh", "edit", "completed", { path }, diff("callsOf(session, except?: string)", "callsOf(session, except: { interval?: Interval; call?: string })")),
      call("toolu_01BqPB", "edit", "running", { path }),
      call("toolu_01BqPB", "edit", "completed", { path }, diff("touch(session: string, call: string | undefined", "touch(session: string, moved: { interval?: Interval; call?: string }")),
      call("toolu_01QjJM", "edit", "running", { path }),
      call("toolu_01QjJM", "edit", "completed", { path }, diff("this.touch(mark.session, mark.kind === \"call\" ? mark.id : undefined", "this.touch(mark.session, { interval, call: mark.kind === \"call\" ? mark.id : undefined }")),
      call("toolu_01JUPL", "edit", "running", { path }),
      call("toolu_01JUPL", "edit", "running", { path }),
    ]) calls.record(message)

    const words = await resumeWords({ calls, root: "root-before-the-edits", since, known: () => new Set(), checkout: (from) => checkoutSince(checkout, from) })
    assert.ok(words, "calls ran past the checkpoint, so the retry tells of them")
    assert.equal(words.calls, 4)
    const text = words.text
    assert.deepEqual(savedResumeAccount(text), { cause: "reconnected", calls: 4 }, "the words are known by their header")
    assert.match(text, /^\[mako · reconnected: you go on from your last saved step, before 4 calls you had already run\]\n/)
    assert.match(text, /1\. edit: `[^`]*evidence\.ts`\n   Finished\./, "each call names its tool and input, and that it finished")
    assert.match(text, /\+touch\(session: string, moved: \{ interval\?: Interval; call\?: string \}/, "a finished edit's result is its diff: the `moved` the resumed model found and disowned")
    assert.match(text, /4\. edit: `[^`]*evidence\.ts`\n   Started, and no result came back: it may have run in full, in part, or not at all\./, "the cut-off edit is named as unfinished")
    assert.match(text, /In the checkout since that step:\n- mako: Files changed: mako\/packages\/host\/src\/attribution\/evidence\.ts\./, "the file the edits changed is named, by the checkout's own path")
    assert.doesNotMatch(text, /HEAD moved|New commit/, "nothing was committed")
    assert.match(text, /treat everything here as your own work/)

    // The words went as a message but no checkpoint holds them yet: another retry on the same checkpoint tells them again.
    const again = await resumeWords({ calls, root: "root-before-the-edits", since, known: () => new Set(), checkout: async () => [] })
    assert.equal(again?.calls, 4, "a retry before a new checkpoint repeats them")
    // A checkpoint landed after the words: it holds them, so a later retry tells only what ran since.
    calls.record(call("toolu_late", "shell", "running", { command: "npx tsgo -p packages/host --noEmit" }))
    const later = await resumeWords({ calls, root: "root-after-the-words", since, known: () => new Set(), checkout: async () => [] })
    assert.equal(later?.calls, 1, "calls told of on a checkpoint since are known")
    assert.match(later!.text, /1\. shell: `npx tsgo -p packages\/host --noEmit`\n   Started/)
    const none = await resumeWords({ calls, root: "root-after-the-words", since, known: () => new Set(["toolu_late"]), checkout: async () => [] })
    assert.equal(none, undefined, "a call whose result the checkpoint holds is no news")
  }

  // fin-models, 12:12: one shell call edited AGENTS.md, committed with the
  // Cursor trailer and pushed; the socket reset before its result came back.
  {
    const { checkout, repository } = project("commit-push", { "AGENTS.md": "# Agents\n" })
    const before = git(repository, "rev-parse", "HEAD")
    await nextSecond()
    const since = Date.now()
    await pause(20)
    writeFileSync(join(repository, "AGENTS.md"), "# Agents\n\nThe person's rules for Fins.\n")
    git(repository, "add", "-A")
    git(repository, "commit", "-q", "-m", "The person's rules for Fins: which work goes to which harness and model", "-m", "Co-authored-by: Cursor <cursoragent@cursor.com>")
    git(repository, "push", "-q", "origin", "HEAD")
    const after = git(repository, "rev-parse", "HEAD")
    const command = "python3 - <<'EOF'\n…AGENTS.md…\nEOF\ngit add -A && git commit -q -F - <<'EOF'\nThe person's rules for Fins\nEOF\ngit push -q origin HEAD"
    const calls = new RunCallLog()
    calls.record(call("toolu_01Euqa", "shell", "running", { command }))
    const words = await resumeWords({ calls, root: "root-before-the-commit", since, known: () => new Set(), checkout: (from) => checkoutSince(checkout, from) })
    assert.ok(words)
    const text = words.text
    assert.match(text, /before 1 call you had already run\]/)
    assert.match(text, /1\. shell, with input:\n   ```\n   python3 - <<'EOF'[\s\S]*   git push -q origin HEAD\n   ```\n   Started, and no result came back/, "a multi-line command is given whole, fenced under its call")
    assert.ok(text.includes(`HEAD moved ${before.slice(0, 8)} → ${after.slice(0, 8)} (commit: The person's rules for Fins: which work goes to which harness and model).`), "the commit it made moved HEAD")
    assert.ok(text.includes(`New commit: ${after.slice(0, 8)} The person's rules for Fins: which work goes to which harness and model.`), "the commit is named by its subject")
    assert.ok(text.includes(`origin/mako/fin moved ${before.slice(0, 8)} → ${after.slice(0, 8)} (update by push).`), "and the push that followed it")
    assert.match(text, /Files changed: mako\/AGENTS\.md\./)

    const quiet = await checkoutSince(checkout, Date.now() + 2_000)
    assert.deepEqual(quiet, [], "nothing moved after the push")
  }

  // The words, saved or live, are one quiet line in the turn, never the person's question.
  {
    const account = resumeAccountText({ cause: "reconnected", checkout: [], calls: [{ tool: "edit", input: "a.ts", state: "finished", result: "+a" }, { tool: "shell", input: "git push", state: "started" }] })!
    assert.equal(resumeAccountLine(savedResumeAccount(account)!), "Reconnected; resumed with 2 calls it had already run")
    assert.equal(resumeAccountLine({ cause: "reconnected", calls: 1 }), "Reconnected; resumed with 1 call it had already run")
    assert.match(account, /Nothing else moved in the checkout since that step/)
    assert.equal(savedResumeAccount("Please fix [mako · reconnected: you go on from your last saved step, before 2 calls you had already run]\n"), undefined, "only a message that opens with the header is one")
    assert.equal(resumeAccountText({ cause: "reconnected", checkout: [], calls: [] }), undefined, "no call ran past the checkpoint: nothing to tell")

    const prompt: ChatMessage = { id: "p", role: "user", requestId: "request-1", timestamp: 1, blocks: [{ type: "text", text: "Stop attribution from stalling the host" }] }
    const work: ChatMessage = { id: "w", role: "assistant", provider: "cursor", timestamp: 2, blocks: [{ type: "text", text: "Found it." }] }
    const answer: ChatMessage = { id: "x", role: "assistant", provider: "cursor", timestamp: 4, blocks: [{ type: "text", text: "Fixed the report() call site." }] }
    for (const resumed of [
      { id: "r", role: "user", timestamp: 3, blocks: [{ type: "text", text: account }] },
      { id: "r", role: "user", timestamp: 3, steeringFor: "run-the-driver-named", blocks: [{ type: "text", text: account }] },
    ] satisfies ChatMessage[]) {
      const exchanges = toExchanges([prompt, work, resumed, answer])
      assert.equal(exchanges.length, 1, `${resumed.steeringFor ? "live" : "saved"}: the words join the turn, never a question of their own`)
      const exchange = exchanges[0]!
      assert.equal(turnRequest(exchange), "request-1", "the turn still stands on the person's request")
      assert.equal(continuedFrom(exchange), 0)
      const sections = responseSections(exchange.response)
      const line = sections.find((section) => section.kind === "resumed")
      assert.ok(line && line.kind === "resumed", "they draw as the resumed line")
      assert.deepEqual(line.resumed, { cause: "reconnected", calls: 2 })
      assert.ok(stillDrawn(line), "a fold keeps the line in view")
      assert.ok(!sections.some((section) => section.kind === "steer"), "and never as the person's steer")
    }
  }
  console.log("Resume account: a cut-off edit and a commit and push mid-call are each told by tool, input, end and result, with what moved in the checkout (HEAD, commits, pushes, files); told again only until a checkpoint holds the words; drawn as one quiet line live and saved")
} finally {
  rmSync(root, { recursive: true, force: true })
}
