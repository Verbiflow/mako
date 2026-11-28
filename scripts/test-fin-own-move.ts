import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { WorkspaceMoves } from "@mako/host/workspaces/moves"
import { moveablePlace, workspaceTools } from "@mako/host/workspaces/tools"
import { moveSource, ThreadWorktreeMoves } from "@mako/host/workspaces/thread-worktree-moves"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * A Fin's own move onto its own branch never ends its delegation or deletes
 * its work (`npm run test:fin-own-move`). On 2026-11-18 four Fins that called
 * `worktree_move` were ended "the person archived it" though nobody had: the
 * move forked their conversation into the worktree and archived the one it
 * left, and `Agents.archived` read that as the person archiving the Thread.
 * Two of them had their turn start while the worktree was being made; the
 * move gave the worktree back, deleting the branch they had asked for, and
 * forked. Here the real Thread store, conversations, `Agents`, worktree
 * service and moves run on a scratch repository, the archive wired as the
 * host wires it (`core.ts`'s `archivedThread`).
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-fin-own-move-")))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fin", GIT_AUTHOR_EMAIL: "fin@example.invalid", GIT_COMMITTER_NAME: "Fin", GIT_COMMITTER_EMAIL: "fin@example.invalid" } }).trim()

async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

/** A repository the world works in: only `app/` is the project's, the world's own files are excluded. */
function repository(name: string): string {
  const repo = join(root, name)
  mkdirSync(join(repo, "app"), { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, ".git", "info", "exclude"), "/*\n!/app/\n")
  writeFileSync(join(repo, "app", "index.ts"), "export const answer = 41\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "first")
  return repo
}

async function scenario(name: string, options: { elsewhere: boolean; busyWhileMade: boolean }) {
  const repo = repository(name)
  const branch = `${name}-kept`
  let fin = ""
  let finTurns = 0
  let workspace!: WorkspaceMoves
  let worktrees!: ThreadWorktreeService
  const script: Script = async (turn) => {
    if (turn.conversation === fin || turn.text.includes("You're fin:")) {
      finTurns += 1
      if (finTurns === 1) {
        // The Fin calls worktree_move with a branch of its own, mid-turn, as `workspace/tools.ts` does.
        await worktrees.wantBranch(turn.conversation, repo, { branch })
        await workspace.ask(turn.conversation)
        return "Moving onto my own branch."
      }
      if (turn.text.includes("One more thing")) await turn.world.hold(turn.conversation)
      return "Carried on."
    }
    return "ok"
  }
  const world = new AgentsWorld({ root: repo, script, elsewhere: options.elsewhere })
  const store = world.store
  const ended: string[] = []
  // A turn that begins while the worktree is made, as model-load's and transcript-render's did.
  const service = new (class extends ThreadWorktreeService {
    override async prepareFork(...args: Parameters<ThreadWorktreeService["prepareFork"]>) {
      const made = await super.prepareFork(...args)
      if (options.busyWhileMade) {
        world.say(fin, "One more thing: check the docs too.")
        await until("its next turn to start while the worktree is made", () => world.live.session(fin)?.status === "running")
      }
      return made
    }
  })(new Git(), join(root, `${name}-worktrees`), store)
  worktrees = service
  const threadMoves = new ThreadWorktreeMoves({
    conversations: world.live,
    worktrees,
    threadOf: (id) => store.journalPlacement(id)?.thread,
    archived: (id) => world.archived.has(id),
    // As the host does: the lifecycle marks it archived, then `archivedThread` tells Agents.
    archive: (id) => {
      world.archived.add(id)
      void world.agents.archived(id).then((closed) => { if (closed) ended.push(id) })
    },
    moved: () => {},
    launch: async (_harness, _cwd, tuning) => tuning,
    warn: () => {},
  })
  const failures: string[] = []
  writeFileSync(join(root, `${name}-moves.json`), JSON.stringify({ alwaysAllowed: [repo] }))
  workspace = new WorkspaceMoves({
    file: join(root, `${name}-moves.json`),
    source: (id) => moveSource(world.live, id),
    companions: (id) => threadMoves.companions(id),
    place: async (id, cwd) => ({ project: threadMoves.project(id) ?? cwd, changed: 0 }),
    move: async (id) => (await threadMoves.carry(id, { lead: true, tell: true, waitTurn: true })).session.id,
    follow: async (id, told, lead) => { await threadMoves.carry(id, { lead: false, tell: told, after: lead }) },
    announce: () => {},
    failed: (_id, message) => failures.push(message),
  })
  // As the host's conversation changes reach `WorkspaceMoves.settled`.
  const settling = setInterval(() => { if (fin) workspace.settled(fin) }, 20)

  try {
    const apex = await world.apex("cursor", "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Fix the answer" }, harness: "claude", name: "fixer", clientKey: "fixer", cwd: repo })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    fin = started.conversation!
    const thread = ThreadIdSchema.parse(store.journalPlacement(fin)!.thread)

    if (options.busyWhileMade) {
      await until("its turn to begin while the worktree is made", () => world.prompts.some((prompt) => prompt.text.includes("One more thing")), 30_000)
      // The move waits on that turn rather than giving the worktree back; it ends a moment later.
      await pause(300)
      world.release(fin)
    }
    await until("the carry-on message", () => world.prompts.some((prompt) => prompt.text.includes("You're on this Thread's own branch now")) || failures.length > 0, 30_000)
    await world.settle(400)

    assert.deepEqual(failures, [], "the move went through")
    const edge = store.edges().of(thread)!
    assert.equal(edge.closedAt, undefined, `its delegation stays open (${edge.closedReason ?? ""})`)
    assert.deepEqual(ended, [], "nothing ended it as the person's archive")
    const state = world.agents.roster(apex.conversation).find((each) => each.child?.name === "fixer")?.child?.state
    assert.notDeepEqual(state, { kind: "ended", outcome: "stopped", reason: "the person archived it" })
    const checkout = service.threadCheckout(fin)
    assert.ok(checkout && existsSync(checkout.path), "its worktree is there")
    assert.equal(service.ofConversation(fin)?.branch, branch, "on the branch it asked for")
    assert.equal(git(repo, "branch", "--list", "--format=%(refname:short)", branch), branch, "and the branch is there")
    const goesOn = world.prompts.find((prompt) => prompt.text.includes("You're on this Thread's own branch now"))!.conversation
    assert.equal(store.journalPlacement(goesOn)?.thread, thread, "the conversation that goes on there is the Fin's Thread")
    assert.equal(service.threadCheckout(goesOn)?.path, checkout!.path, "and works in its worktree")
    // The scripted harness reports the folder it was started in only when it goes on elsewhere.
    if (options.elsewhere) assert.ok(realpathSync(world.live.session(goesOn)!.cwd).startsWith(realpathSync(checkout!.path)), `in its worktree: ${world.live.session(goesOn)?.cwd}`)
    if (options.elsewhere) assert.equal(goesOn, fin, "it moved as itself, after its turn, rather than forking")
    else assert.ok(world.archived.has(fin) && goesOn !== fin, "it forked there, and the Session it left is archived")
    // The person archiving the Thread, every Session of it, still ends it.
    for (const conversation of new Set([fin, goesOn])) {
      world.archived.add(conversation)
      await world.agents.archived(conversation)
    }
    assert.deepEqual(world.agents.roster(apex.conversation).find((each) => each.child?.name === "fixer")?.child?.state, { kind: "ended", outcome: "stopped", reason: "the person archived it" })
  } finally {
    clearInterval(settling)
    await world.close()
  }
}

/**
 * 2026-11-28: a Fin's Apex worked in its own worktree and started it with no workspace, so it began in
 * the Apex's worktree, and its worktree_move onto a new branch from the commit production runs was refused as "a worktree
 * made outside Mako". The Apex's worktree is Mako's: the Fin moves out of it onto a branch of its own, from the base it
 * named, and the Apex's worktree and branch stay as they are.
 */
async function leavesApexWorktree(harness: "claude" | "codex") {
  const name = `apex-worktree-${harness}`
  const repo = repository(name)
  const main = git(repo, "rev-parse", "HEAD")
  // The Apex's branch moves on from main, so a Fin that names main as its base doesn't start from the Apex's work.
  const branch = `fix/own-${harness}`
  let fin = ""
  let asked: string | undefined
  let workspace!: WorkspaceMoves
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) {
      const cwd = turn.world.live.session(turn.conversation)!.cwd
      // worktree_move(branch, base) as `workspace/tools.ts` takes it.
      await worktrees.wantBranch(turn.conversation, cwd, { branch, base: main }).then(() => workspace.ask(turn.conversation)).then((said) => { asked = said }, (error: Error) => { asked = `refused: ${error.message}` })
      return "Moving onto my own branch."
    }
    return "ok"
  }
  const world = new AgentsWorld({ root: repo, script, elsewhere: true })
  const store = world.store
  const worktrees = new ThreadWorktreeService(new Git(), join(root, `${name}-worktrees`), store)
  const threadMoves = new ThreadWorktreeMoves({
    conversations: world.live,
    worktrees,
    threadOf: (id) => store.journalPlacement(id)?.thread,
    archived: (id) => world.archived.has(id),
    archive: (id) => { world.archived.add(id) },
    moved: () => {},
    launch: async (_harness, _cwd, tuning) => tuning,
    warn: () => {},
  })
  const failures: string[] = []
  writeFileSync(join(root, `${name}-moves.json`), JSON.stringify({ alwaysAllowed: [] }))
  workspace = new WorkspaceMoves({
    file: join(root, `${name}-moves.json`),
    source: (id) => moveSource(world.live, id),
    companions: (id) => threadMoves.companions(id),
    // As the host places a move (`workspaces/index.ts`).
    place: (id, cwd) => moveablePlace(new Git(), worktrees, id, threadMoves.project(id) ?? cwd),
    move: async (id) => (await threadMoves.carry(id, { lead: true, tell: true, waitTurn: true })).session.id,
    follow: async (id, told, lead) => { await threadMoves.carry(id, { lead: false, tell: told, after: lead }) },
    announce: () => {},
    tier: () => "full",
    failed: (_id, message) => failures.push(message),
  })
  const settling = setInterval(() => { if (fin) workspace.settled(fin) }, 20)
  try {
    const apex = await world.apex(harness, "full")
    // The Apex works in its own worktree, on its own branch, a commit past main.
    world.say(apex.conversation, "Fix the webhook on a branch of its own.")
    await world.settle()
    await threadMoves.carry(apex.conversation, { lead: true, tell: false })
    const apexCheckout = worktrees.threadCheckout(apex.conversation)!
    assert.ok(apexCheckout, "the Apex has its worktree")
    writeFileSync(join(apexCheckout.path, "app", "index.ts"), "export const answer = 42\n")
    git(apexCheckout.path, "commit", "-qam", "the Apex's work")
    const { status } = workspaceTools({ git: new Git(), cwd: (id) => world.live.session(id)?.cwd, worktrees, moves: workspace, changed: () => {} })
    const started = await world.agents.start(apex.caller, { brief: { objective: "Fix it on a branch of its own" }, harness, name: "own", clientKey: "own" })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    fin = started.conversation!
    assert.equal(realpathSync(world.live.session(fin)!.cwd), realpathSync(apexCheckout.path), "it starts in its Apex's worktree")
    const where = await status(fin)
    assert.equal(where.editsIn, "another Thread's worktree", JSON.stringify(where))
    assert.equal(where.otherThreadWorktree?.branch, apexCheckout.branch)
    await until("the carry-on message", () => world.prompts.some((prompt) => prompt.conversation !== apex.conversation && prompt.text.includes("You're on this Thread's own branch now")) || failures.length > 0 || asked?.startsWith("refused") === true, 30_000)
    assert.doesNotMatch(asked ?? "", /^refused/, "its move isn't refused")
    assert.deepEqual(failures, [], "and goes through")
    await world.settle(400)
    const own = worktrees.threadCheckout(fin)
    assert.ok(own && existsSync(own.path), "its own worktree is there")
    assert.notEqual(own!.path, apexCheckout.path, "apart from its Apex's")
    assert.equal(own!.branch, branch, "on the branch it asked for")
    assert.equal(git(own!.path, "rev-parse", "HEAD"), main, "from the base it named, not the Apex's work")
    assert.equal(git(apexCheckout.path, "branch", "--show-current"), apexCheckout.branch, "its Apex's worktree stays on its branch")
    assert.equal(worktrees.threadCheckout(apex.conversation)?.path, apexCheckout.path, "and stays its Apex's")
    assert.equal(store.edges().of(ThreadIdSchema.parse(store.journalPlacement(fin)!.thread))?.closedAt, undefined, "its delegation stays open")
  } finally {
    clearInterval(settling)
    await world.close()
  }
}

/** Naming a case (`forks`, `busy`, `apex-worktree`) runs it alone. */
const only = process.argv[2]
try {
  if (!only || only === "forks") {
    await scenario("forks", { elsewhere: false, busyWhileMade: false })
    console.log("a Fin whose worktree_move forked it: its delegation, Thread, worktree and branch stay, and the person's archive still ends it")
  }
  if (!only || only === "busy") {
    await scenario("busy", { elsewhere: true, busyWhileMade: true })
    console.log("a Fin whose turn began while its worktree was made: it moved as itself once the turn ended, its branch kept")
  }
  if (!only || only === "apex-worktree") {
    for (const harness of ["claude", "codex"] as const) {
      await leavesApexWorktree(harness)
      console.log(`${harness}: a Fin started in its Apex's worktree moves out onto its own branch, from the base it named`)
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("fin own move: ok")
