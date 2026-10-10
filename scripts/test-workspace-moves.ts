import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { ThreadIdSchema } from "../electron/contracts/thread-identity.js"
import type { ThreadWorktree, WorktreeReview, WorktreeSummary, WorktreeUpdate } from "../electron/contracts/thread-worktrees.js"
import type { ThreadCheckout } from "../electron/thread-worktrees.js"
import type { WorkspaceMoves as WorkspaceMovesState } from "../electron/contracts/workspace-moves.js"
import { MAKO_COMPUTER_SERVER, MAKO_THREAD_SERVER } from "../electron/contracts/mcp-reach.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { WorkspaceMoves, type MoveSource } from "../electron/workspace-moves.js"
import { RECIPE_PATH } from "../electron/thread-recipe.js"
import { foldIgnored, moveablePlace, workspaceTools } from "../electron/workspace-tools.js"
import { gitActionPrompt } from "../electron/contracts/git-actions.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-workspace-moves-")))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const agent = new Client({ name: "workspace-agent", version: "1" })
let grants: Awaited<ReturnType<typeof startConversationMcp>> | undefined

try {
  // Thousands of loose recordings fold to one pattern; the short lists beside them show whole.
  const recordings = Array.from({ length: 3000 }, (_, index) => `api/audits/day-${index % 3}/frame-${index}.png`)
  const short = ["api/.dev.vars", "api/node_modules", "api/apps/gateway/.dev.vars", "web/.env.local", "web/node_modules", "web/docs/notes", "web/docs/plan.md", ".tool-versions"]
  const folded = foldIgnored([...recordings, ...short], 20)
  assert.ok(folded.length <= 20)
  for (const entry of short) assert.ok(folded.includes(entry), `${entry} is listed`)
  assert.deepEqual(folded.filter((entry) => entry.endsWith("/**")), ["api/audits/day-0/**", "api/audits/day-1/**", "api/audits/day-2/**"])
  assert.deepEqual(foldIgnored(["b", "a/c"], 20), ["a/c", "b"], "a list that fits stays as it is")

  // A project with one commit and two uncommitted files, and a folder of this Thread's "worktree".
  const project = join(root, "project")
  mkdirSync(project)
  git(project, "init", "-q", "-b", "main")
  writeFileSync(join(project, "a.txt"), "a")
  git(project, "add", ".")
  git(project, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one")
  writeFileSync(join(project, "a.txt"), "changed")
  writeFileSync(join(project, "b.txt"), "new")
  const worktreePath = join(root, "worktree")
  git(project, "worktree", "add", "-q", "-b", "mako/thread", worktreePath)
  const worktree: ThreadWorktree = { path: worktreePath, thread: ThreadIdSchema.parse(randomUUID()), repoRoot: project, project, branch: "mako/thread", base: git(project, "rev-parse", "HEAD"), createdAt: Date.now() }

  let placed: ThreadWorktree | undefined
  let projectCheckout: ThreadCheckout | undefined
  const reviews = new Map<string, WorktreeReview>()
  const mergedPaths: string[] = []
  const removedPaths: string[] = []
  const updates: WorktreeUpdate[] = [
    { kind: "conflicts", from: "origin/main", files: ["a.txt", "b.txt"] },
    { kind: "updated", from: "origin/main", commits: 2 },
    { kind: "current", from: "origin/main" },
  ]
  const worktrees = {
    threadCheckout: () => projectCheckout ?? (placed && { path: placed.path, project: placed.repoRoot, branch: placed.branch, worktrees: [placed] }),
    review: async (path: string) => reviews.get(path) ?? assert.fail(`no review of ${path}`),
    ahead: async () => 0,
    merge: async (path: string) => {
      mergedPaths.push(path)
      return { branch: worktree.branch, into: "main" }
    },
    remove: async (path: string) => {
      removedPaths.push(path)
      return { root, worktrees: [] }
    },
    update: async () => updates.shift()!,
    summary: async (path: string): Promise<WorktreeSummary & { startedFrom: string | null }> => ({
      path, into: "main", ahead: 1, changes: 0, startedFrom: "origin/main",
      landing: { kind: "open", into: "main", commits: 1 },
      pull: { number: 7, title: "Thread work", url: "https://github.com/o/r/pull/7", branch: "mako/thread", state: "open", head: "abc", checks: "failed" },
      behind: { from: "origin/main", commits: 2 },
    }),
  }

  assert.deepEqual(await moveablePlace(worktrees, "c", project), { project, changed: 2 }, "a new worktree takes the checkout's uncommitted files")
  const plain = join(root, "plain")
  mkdirSync(plain)
  assert.deepEqual(await moveablePlace(worktrees, "c", plain), { refused: "This folder isn't in a Git repository and holds none, so there's no branch to move onto." })
  assert.deepEqual(await moveablePlace(worktrees, "c", root), { project: realpathSync(root), changed: 2 }, "a project folder holding repositories moves onto one branch in each, with each one's uncommitted files")
  assert.deepEqual(await moveablePlace(null, "c", project), { refused: "Worktrees need the Thread store, which didn't open." })
  placed = worktree
  assert.deepEqual(await moveablePlace(worktrees, "c", project), { project, joins: "mako/thread", changed: 0 }, "a Thread with a worktree is joined and nothing moves")
  const inside = await moveablePlace(worktrees, "c", worktreePath)
  assert.ok(inside.refused)
  assert.match(inside.refused, /already edits in this Thread's worktree, .*, on mako\/thread\.$/)
  placed = undefined

  // The request's life: asked, answered once or for the project, carried out when the turn ends.
  const file = join(root, "userData", "workspace-moves.json")
  const sources = new Map<string, MoveSource>([["c", { cwd: project, harness: "claude", title: "Fix the tests", busy: true }]])
  const announced: WorkspaceMovesState[] = []
  const moved: string[] = []
  const failures: string[] = []
  const companions = new Map<string, string[]>()
  const followers: [id: string, told: boolean, lead: string][] = []
  let holdFollow: Promise<void> | undefined
  const deps = {
    file,
    source: (id: string) => sources.get(id),
    companions: (id: string) => companions.get(id) ?? [],
    place: (id: string, cwd: string) => moveablePlace(worktrees, id, cwd),
    move: async (id: string) => {
      moved.push(id)
      if (id === "broken") throw new Error("prepare failed")
      return `${id} there`
    },
    follow: async (id: string, told: boolean, lead: string) => {
      await holdFollow
      moved.push(`${id} follows`)
      followers.push([id, told, lead])
      if (id === "stuck") throw new Error("“Stuck” stayed in the main checkout")
    },
    announce: (state: WorkspaceMovesState) => announced.push(state),
    failed: (_id: string, message: string) => failures.push(message),
  }
  const moves = new WorkspaceMoves(deps)
  assert.match(await moves.ask("c"), /^Asked the user\..*into a new worktree for this Thread, on a branch of its own, with the 2 uncommitted files in this checkout/s)
  const [request] = moves.state().requests
  assert.ok(request)
  assert.deepEqual({ ...request, id: "" }, { id: "", conversationId: "c", harness: "claude", title: "Fix the tests", project, changed: 2, state: "asking" })
  assert.equal(moves.answerFor("c"), "asking")
  assert.match(await moves.ask("c"), /^Asked the user/, "asking again keeps the one request")
  assert.equal(moves.state().requests.length, 1)

  moves.answer(request.id, "allow")
  assert.equal(moves.answerFor("c"), "allowed")
  assert.deepEqual(moved, [], "nothing moves under a running turn")
  moves.settled("c")
  assert.deepEqual(moved, [], "nor while it still runs")
  sources.set("c", { ...sources.get("c")!, busy: false })
  moves.settled("c")
  moves.settled("c")
  assert.deepEqual(moved, ["c"], "the turn ended: it moves, once")
  assert.equal(moves.state().requests.length, 0)
  assert.equal(existsSync(file), false, "a one-time answer isn't remembered")
  await delay(0)
  assert.equal(moves.answerFor("c"), undefined)

  // The turn ended but something else is still going on: the move waits, and the card says on what.
  sources.set("w", { cwd: project, harness: "codex", title: "Wait", busy: false, waiting: "is saving or rewinding its workspace" })
  sources.set("helper", { cwd: project, harness: "claude", title: "Helper", busy: false })
  companions.set("w", ["helper"])
  await moves.ask("w")
  const waits = moves.state().requests.find((candidate) => candidate.conversationId === "w")!
  const shown = announced.length
  moves.answer(waits.id, "allow")
  assert.deepEqual(moved, ["c"], "a checkpoint still being saved holds the move")
  assert.equal(moves.state().requests.find((candidate) => candidate.id === waits.id)?.waiting, "this session is saving or rewinding its workspace")
  assert.ok(announced.length > shown, "the card learns what it waits for")
  sources.set("w", { ...sources.get("w")!, waiting: undefined })
  sources.set("helper", { ...sources.get("helper")!, waiting: "has background tasks running" })
  moves.settled("w")
  assert.deepEqual(moved, ["c"], "so does a companion's background task")
  assert.equal(moves.state().requests.find((candidate) => candidate.id === waits.id)?.waiting, "“Helper” has background tasks running")
  sources.set("helper", { ...sources.get("helper")!, waiting: undefined })
  moves.settled("helper")
  await delay(0)
  await delay(0)
  assert.deepEqual(moved, ["c", "w", "helper follows"], "once nothing holds it, it moves")
  companions.clear()
  moved.length = 1

  // Don't allow: the card goes, and the agent's status says so.
  sources.set("d", { cwd: project, harness: "codex", busy: true })
  await moves.ask("d")
  const denied = moves.state().requests.find((candidate) => candidate.conversationId === "d")!
  moves.answer(denied.id, "deny")
  moves.answer(denied.id, "allow")
  assert.equal(moves.answerFor("d"), "declined", "a repeated or late answer changes nothing")
  assert.equal(moves.state().requests.length, 0)
  moves.settled("d")
  assert.deepEqual(moved, ["c"])

  // Always allow: remembered for the project, and the next agent there doesn't ask.
  sources.set("e", { cwd: project, harness: "claude", busy: true })
  await moves.ask("e")
  moves.answer(moves.state().requests[0]!.id, "always")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { alwaysAllowed: [project] })
  sources.set("f", { cwd: join(project), harness: "cursor", busy: true })
  const reopened = new WorkspaceMoves(deps)
  assert.deepEqual(reopened.state().alwaysAllowed, [project], "remembered across restarts")
  assert.match(await reopened.ask("f"), /^Allowed: this project lets agents move without asking\./)
  assert.equal(reopened.answerFor("f"), "allowed")
  moves.forget(project)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { alwaysAllowed: [] })
  assert.deepEqual(moves.state().alwaysAllowed, [])
  assert.equal(announced.at(-1)?.alwaysAllowed.length, 0)

  // A move that fails is reported, and the conversation can ask again.
  sources.set("broken", { cwd: project, harness: "claude", busy: false })
  await moves.ask("broken")
  moves.answer(moves.state().requests.find((candidate) => candidate.conversationId === "broken")!.id, "allow")
  await delay(0)
  assert.deepEqual(failures, ["prepare failed"])
  assert.equal(moves.answerFor("broken"), undefined)

  // The whole Thread moves: once the asker's turn and every companion's have ended, the asker first, then each companion.
  moved.length = 0
  failures.length = 0
  followers.length = 0
  sources.set("lead", { cwd: project, harness: "codex", busy: true })
  sources.set("mate", { cwd: join(project, "web"), harness: "claude", busy: true })
  sources.set("stuck", { cwd: project, harness: "grok", busy: false })
  mkdirSync(join(project, "web"), { recursive: true })
  await moves.ask("mate")
  companions.set("lead", ["mate", "stuck"])
  assert.match(await moves.ask("lead"), /When this turn and those of this Thread's 2 other Sessions here end, Mako moves them all/)
  moves.answer(moves.state().requests.find((candidate) => candidate.conversationId === "lead")!.id, "allow")
  sources.set("lead", { ...sources.get("lead")!, busy: false })
  moves.settled("lead")
  assert.deepEqual(moved, [], "a companion mid-turn holds the move")
  sources.set("mate", { ...sources.get("mate")!, busy: false })
  moves.settled("mate")
  assert.equal(moves.answerFor("mate"), "moving", "a companion's status says it's moving")
  await delay(0)
  await delay(0)
  assert.deepEqual(moved, ["lead", "mate follows", "stuck follows"])
  assert.deepEqual(failures, ["“Stuck” stayed in the main checkout"], "a companion that can't follow is reported; the others still move")
  assert.deepEqual(followers, [["mate", true, "lead there"], ["stuck", false, "lead there"]],
    "each follows where the asker goes on, and one whose agent had asked too hears where it is")
  assert.equal(moves.answerFor("lead"), undefined)
  assert.equal(moves.answerFor("mate"), undefined, "the move answered the companion's own request")
  companions.clear()

  // The person moves the Thread from the composer: nothing is asked, its other Sessions follow,
  // and what they're finishing gets a short wait before the move is refused, moving nothing.
  const now = new WorkspaceMoves({ ...deps, settleMs: 60 })
  const carriedNow: string[] = []
  const carry = (id: string) => async (told: boolean) => {
    carriedNow.push(`${id}${told ? " told" : ""}`)
    if (id === "fails") throw new Error("the worktree couldn't be made")
    return { session: { id: `${id} there` } }
  }
  moved.length = 0
  followers.length = 0
  failures.length = 0
  sources.set("person", { cwd: project, harness: "claude", title: "Person's", busy: false })
  sources.set("helper", { cwd: join(project, "web"), harness: "codex", title: "Helper", busy: false })
  sources.set("quiet", { cwd: project, harness: "grok", busy: false })
  companions.set("person", ["helper", "quiet"])
  assert.deepEqual(now.hold("person", ["helper", "quiet"]), { companions: [{ id: "helper", title: "Helper" }, { id: "quiet" }] },
    "the composer hears which Sessions would come along, and that nothing holds them")
  await now.ask("helper")
  const done = await now.moveNow("person", carry("person"))
  assert.equal(done.moved.session.id, "person there")
  assert.deepEqual(carriedNow, ["person"], "the person's own move tells its agent nothing")
  assert.equal(now.answerFor("helper"), "moving")
  assert.equal(now.state().requests.length, 0, "a companion's request is answered by the move")
  await done.following
  assert.deepEqual(followers, [["helper", true, "person there"], ["quiet", false, "person there"]], "the Thread's other Sessions follow it, the one that had asked told where it is")
  assert.equal(now.answerFor("person"), undefined)
  assert.equal(now.answerFor("quiet"), undefined)

  sources.set("helper", { ...sources.get("helper")!, busy: true })
  const pending = now.moveNow("person", carry("person"))
  await delay(10)
  assert.deepEqual(carriedNow, ["person"], "a companion's turn holds the person's move")
  sources.set("helper", { ...sources.get("helper")!, busy: false, waiting: "is saving or rewinding its workspace" })
  now.settled("helper")
  await delay(10)
  assert.deepEqual(carriedNow, ["person"], "and so does its checkpoint")
  sources.set("helper", { ...sources.get("helper")!, waiting: undefined })
  now.settled("helper")
  await (await pending).following
  assert.deepEqual(carriedNow, ["person", "person"], "it goes as soon as they're done")

  sources.set("helper", { ...sources.get("helper")!, busy: true })
  sources.set("quiet", { ...sources.get("quiet")!, waiting: "has background tasks running" })
  carriedNow.length = 0
  followers.length = 0
  assert.equal(now.hold("person", ["helper", "quiet"]).held, "“Helper” is running a turn; another session has background tasks running",
    "the composer hears beforehand what the move would refuse for")
  assert.equal(now.hold(undefined, ["person", "helper"]).held, "“Helper” is running a turn",
    "a Thread in the viewer, with no live Session on screen, names each one")
  await assert.rejects(now.moveNow("person", carry("person")),
    /^Error: “Helper” is running a turn; another session has background tasks running, so the Thread can't move onto its own branch yet\. Move it once they're done\.$/)
  assert.deepEqual([carriedNow, followers], [[], []], "a refused move moves nothing")
  sources.set("helper", { ...sources.get("helper")!, busy: false })
  sources.set("quiet", { ...sources.get("quiet")!, waiting: undefined })
  sources.set("person", { ...sources.get("person")!, waiting: "has subagents running" })
  await assert.rejects(now.moveNow("person", carry("person")), /^Error: This session has subagents running, so the Thread can't move onto its own branch yet\. Move it once that's done\.$/)
  sources.set("person", { ...sources.get("person")!, waiting: undefined })

  let release = () => {}
  holdFollow = new Promise((resolve) => { release = resolve })
  const slowMove = await now.moveNow("person", carry("person"))
  assert.equal(now.hold("person", ["helper", "quiet"]).moving, true, "the composer hears the Thread is moving already")
  await assert.rejects(now.moveNow("quiet", carry("quiet")), /already moving this Thread/, "a second move while the first is still bringing Sessions along is refused")
  await assert.rejects(now.moveNow("person", carry("person")), /already moving this Thread/)
  release()
  await slowMove.following
  holdFollow = undefined
  assert.equal(now.hold("person", ["helper", "quiet"]).moving, undefined, "and that it's done")

  sources.set("fails", { cwd: project, harness: "claude", busy: false })
  companions.set("fails", ["quiet"])
  followers.length = 0
  await assert.rejects(now.moveNow("fails", carry("fails")), /the worktree couldn't be made/)
  assert.deepEqual(followers, [], "when the Session itself can't move, none follow")
  assert.equal(now.answerFor("fails"), undefined, "and it can be moved again")
  assert.equal(now.answerFor("quiet"), undefined)
  companions.clear()

  await assert.rejects(moves.ask("gone"), /isn't running this conversation/)
  sources.delete("e")
  assert.equal(moves.state().requests.some((candidate) => candidate.conversationId === "e"), false, "a closed conversation's request goes")

  // The tools, over the conversation's real HTTP MCP server, act on the calling conversation only.
  const changed: number[] = []
  const recipesRoot = join(root, "recipes")
  const tools = workspaceTools({ recipesRoot, cwd: (id) => sources.get(id)?.cwd, worktrees, moves, changed: () => changed.push(1) })
  let releaseComputer = () => {}
  const computerHeld = new Promise<void>((resolve) => { releaseComputer = resolve })
  grants = await startConversationMcp(
    { authorizeAgent: (conversationId, bindingId) => { assert.equal(bindingId, "binding"); assert.ok(sources.has(conversationId)) } },
    async () => {
      await computerHeld
      return { content: [{ type: "text", text: "done" }] }
    },
    tools,
  )
  sources.set("g", { cwd: project, harness: "claude", busy: true })
  const grant = grants.mint("binding", "g")
  assert.ok(grant.makoUrl, "a host with Thread tools serves the mako server")
  const headers = { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }
  const computer = new Client({ name: "agent", version: "1" })
  await computer.connect(new StreamableHTTPClientTransport(new URL(grant.computerUrl), headers))
  await agent.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl), headers))
  assert.deepEqual([computer.getServerVersion()?.name, agent.getServerVersion()?.name], [MAKO_COMPUTER_SERVER, MAKO_THREAD_SERVER], "each server introduces itself by the name the agent app lists it under")
  assert.deepEqual((await computer.listTools()).tools.map((tool) => tool.name), ["js", "js_reset"], "browser and computer use have a server of their own")
  const listed = (await agent.listTools()).tools
  assert.deepEqual(listed.map((tool) => tool.name), ["worktree_status", "worktree_bring", "worktree_move", "worktree_update", "worktree_merge", "worktree_remove"])
  for (const name of ["worktree_status", "worktree_move", "worktree_update", "worktree_merge", "worktree_remove"])
    assert.match(listed.find((tool) => tool.name === name)!.description!, /^Call (when|first|before)\b/, `${name} opens with when to call it`)
  assert.match(agent.getInstructions() ?? "", /^Mako's tools for the Thread this Session belongs to\./, "the mako server says what it's for")
  for (const word of ["main checkout", "worktree", "checkout", "app", "recipe"])
    assert.match(agent.getInstructions() ?? "", new RegExp(`^- ${word}: `, "m"), `the instructions define "${word}", the word every tool uses`)
  // Each client numbers its own requests, so the same number on both servers is two different calls.
  const slow = computer.callTool({ name: "js", arguments: { code: "1" } })
  await delay(100)
  const concurrent = await agent.callTool({ name: "worktree_status", arguments: {} })
  assert.equal(concurrent.isError, undefined, "a call on one server doesn't block the same request number on the other")
  releaseComputer()
  await slow
  await computer.close()
  assert.match(listed.find((tool) => tool.name === "worktree_move")!.description!, /instead of `git worktree add`/)
  assert.equal(listed.find((tool) => tool.name === "worktree_status")!.annotations?.readOnlyHint, true)
  assert.equal(listed.find((tool) => tool.name === "worktree_remove")!.annotations?.destructiveHint, true)
  const text = (result: Awaited<ReturnType<typeof agent.callTool>>) => {
    const [first] = z.array(z.object({ text: z.string() })).parse(result.content)
    assert.ok(first)
    return first.text
  }

  const statusText = text(await agent.callTool({ name: "worktree_status", arguments: {} }))
  assert.equal(statusText, `editsIn: the main checkout\nfolder: ${project}\nbranch: main\nuncommittedFiles: 2`, "worktree_status answers in plain YAML")
  const status = parseYaml(statusText)
  assert.deepEqual(status, { editsIn: "the main checkout", folder: project, branch: "main", uncommittedFiles: 2 })
  const merge = await agent.callTool({ name: "worktree_merge", arguments: {} })
  assert.equal(merge.isError, true)
  assert.match(text(merge), /^This Thread has no worktree; it edits in the main checkout\.$/)

  const asked = await agent.callTool({ name: "worktree_move", arguments: {} })
  assert.equal(asked.isError, undefined)
  assert.match(text(asked), /^Asked the user\. .*worktree_status shows it/)
  assert.equal(moves.state().requests.find((candidate) => candidate.conversationId === "g")?.harness, "claude")
  assert.equal(parseYaml(text(await agent.callTool({ name: "worktree_status", arguments: {} }))).move, "asking")

  placed = worktree
  sources.set("g", { ...sources.get("g")!, cwd: worktreePath })
  const onBranch = parseYaml(text(await agent.callTool({ name: "worktree_status", arguments: {} })))
  assert.equal(onBranch.editsIn, "this Thread's worktree")
  assert.deepEqual(onBranch.threadWorktree, {
    folder: worktreePath, branch: "mako/thread", mainCheckout: project, commitsSinceBranching: 0,
    startedFrom: "origin/main",
    behind: { from: "origin/main", commits: 2 },
    pullRequest: { number: 7, state: "open", url: "https://github.com/o/r/pull/7", checks: "failed" },
  }, "the worktree says where it started, what it lacks and its pull request")

  // Update from main: a conflict hands back the files and how to finish, by the same words the Git sidebar stages.
  const conflicted = await agent.callTool({ name: "worktree_update", arguments: {} })
  assert.equal(conflicted.isError, undefined)
  const stopped = parseYaml(text(conflicted))
  assert.deepEqual(stopped.conflicts, ["a.txt", "b.txt"])
  assert.equal(stopped.next, `${gitActionPrompt({ kind: "resolve", branch: "mako/thread", from: "origin/main", files: ["a.txt", "b.txt"] })} \`git merge --abort\` puts the branch back as it was.`)
  assert.equal(text(await agent.callTool({ name: "worktree_update", arguments: {} })), "Merged 2 commits from origin/main into mako/thread. Run the checks before going on.")
  assert.equal(text(await agent.callTool({ name: "worktree_update", arguments: {} })), "mako/thread already has everything in origin/main.")
  assert.deepEqual(changed, [1, 1], "windows hear of an update that changed the branch, and not of one that didn't")
  // Existing worktrees can catch up, and one-offs leave the project recipe alone.
  writeFileSync(join(project, ".git", "info", "exclude"), "local.json\n.env\n.env.local\n.env.alias\nshared.json\nconfig/\nbundle/\nassets/\n")
  writeFileSync(join(project, "local.json"), '{"main":true}')
  writeFileSync(join(project, ".env"), "TOKEN=fixture-only")
  writeFileSync(join(project, "shared.json"), "shared")
  mkdirSync(join(project, ".mako"))
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ carry: ["local.json"], secrets: [".env", ".env.local", ".env.alias"] }))
  // The project recipe committed with this checkout is read from the worktree too.
  mkdirSync(join(worktreePath, ".mako"))
  writeFileSync(join(worktreePath, RECIPE_PATH), readFileSync(join(project, RECIPE_PATH)))
  const inventory = parseYaml(text(await agent.callTool({ name: "worktree_status", arguments: {} }))).ignoredInMain
  assert.equal(inventory.folder, project)
  assert.ok(inventory.paths.includes(".env") && inventory.paths.includes("local.json"))
  const bring = async (entries?: { path: string; link?: boolean }[]) => agent.callTool({ name: "worktree_bring", arguments: entries ? { entries } : {} })
  const carried = parseYaml(text(await bring()))
  assert.deepEqual([carried.copied, carried.missing], [["local.json", ".env"], [".env.local", ".env.alias"]], "a recipe saved with secrets brings them as carry")
  const refusedBring = await bring([{ path: "shared.json" }, { path: "local.json" }, { path: "local.json", link: true }])
  assert.equal(refusedBring.isError, true)
  assert.match(text(refusedBring), /Both copy and link were requested for local\.json/)
  assert.equal(existsSync(join(worktreePath, "shared.json")), false, "validate the whole request before changing anything")
  assert.equal(lstatSync(join(worktreePath, ".env")).isSymbolicLink(), false, "env files are independent copies by default")
  writeFileSync(join(worktreePath, ".env"), "TOKEN=worktree-only")
  assert.ok(parseYaml(text(await bring())).existing.includes(".env"))
  assert.equal(readFileSync(join(worktreePath, ".env"), "utf8"), "TOKEN=worktree-only")
  assert.equal(readFileSync(join(project, ".env"), "utf8"), "TOKEN=fixture-only")
  writeFileSync(join(project, ".env.local"), "LOCAL=fixture")
  symlinkSync(".env.local", join(project, ".env.alias"))
  await bring([{ path: ".env.alias" }])
  assert.equal(lstatSync(join(worktreePath, ".env.alias")).isSymbolicLink(), false, "a source env symlink still becomes a copy")
  assert.deepEqual(parseYaml(text(await bring([{ path: "shared.json", link: true }]))).linked, ["shared.json"])
  assert.equal(lstatSync(join(worktreePath, "shared.json")).isSymbolicLink(), true)
  assert.deepEqual(parseYaml(text(await bring([{ path: "shared.json" }]))).owned, ["shared.json"], "bringing a linked entry without link makes it the worktree's own")
  assert.equal(lstatSync(join(worktreePath, "shared.json")).isFile(), true)
  writeFileSync(join(worktreePath, "shared.json"), "changed here")
  assert.equal(readFileSync(join(project, "shared.json"), "utf8"), "shared")
  symlinkSync("missing", join(worktreePath, ".env.local"))
  assert.deepEqual(parseYaml(text(await bring([{ path: ".env.local" }]))).existing, [".env.local"], "a broken destination link stays untouched")
  const outside = join(root, "outside")
  mkdirSync(outside)
  mkdirSync(join(project, "config"))
  writeFileSync(join(project, "config", "local.json"), "local")
  symlinkSync(outside, join(worktreePath, "config"))
  assert.match(text(await bring([{ path: "config/local.json" }])), /destination points outside/)
  assert.equal(existsSync(join(outside, "local.json")), false)
  mkdirSync(join(project, "assets"))
  writeFileSync(join(project, "assets", "one.json"), "one")
  writeFileSync(join(project, "assets", "two.txt"), "two")
  assert.deepEqual(parseYaml(text(await bring([{ path: "assets/*.json" }]))).copied, ["assets/one.json"], "patterns work inside a collapsed ignored folder")
  assert.equal(existsSync(join(worktreePath, "assets", "two.txt")), false)
  mkdirSync(join(project, "bundle"))
  writeFileSync(join(project, "bundle", "large.bin"), Buffer.alloc(2 * 1024 * 1024, 7))
  assert.deepEqual(parseYaml(text(await bring([{ path: "bundle" }]))).copied, ["bundle"])
  assert.equal(readFileSync(join(worktreePath, "bundle", "large.bin")).length, 2 * 1024 * 1024)
  writeFileSync(join(worktreePath, "bundle", "large.bin"), "changed")
  assert.equal(readFileSync(join(project, "bundle", "large.bin")).length, 2 * 1024 * 1024, "cloned outputs stay independent")
  assert.deepEqual(parseYaml(text(await bring([{ path: "a.txt" }]))).missing, ["a.txt"], "tracked files aren't brought")
  assert.equal((await bring([{ path: "../outside" }])).isError, true)
  const beforeBring = readFileSync(join(worktreePath, RECIPE_PATH), "utf8")
  await bring([{ path: "local.json" }])
  assert.equal(readFileSync(join(worktreePath, RECIPE_PATH), "utf8"), beforeBring, "one-offs don't change the project recipe")

  assert.match(text(await agent.callTool({ name: "worktree_merge", arguments: {} })), /^Merged mako\/thread into main in the main checkout/)
  assert.match(text(await agent.callTool({ name: "worktree_remove", arguments: {} })), /^Removed this Thread's worktree, .* its branch, mako\/thread, is kept/is)
  assert.deepEqual(removedPaths, [worktreePath])
  assert.deepEqual(changed, [1, 1, 1, 1], "windows are told to read the worktrees again after a merge and a removal")

  // A project folder of several repositories: one worktree per repository on the one branch, merged together or not at all.
  const checkoutPath = join(root, "checkout")
  mkdirSync(checkoutPath)
  const members = ["api", "web"].map((name): ThreadWorktree => ({ ...worktree, path: join(checkoutPath, name), repoRoot: join(root, name), project: root }))
  projectCheckout = { path: checkoutPath, project: root, branch: "mako/thread", worktrees: members }
  sources.set("g", { ...sources.get("g")!, cwd: checkoutPath })
  const ofProject = parseYaml(text(await agent.callTool({ name: "worktree_status", arguments: {} })))
  assert.equal(ofProject.editsIn, "this Thread's worktree", "the folder mirroring the project is the Thread's worktree")
  assert.deepEqual(ofProject.threadWorktree, {
    folder: checkoutPath, branch: "mako/thread", mainCheckout: root,
    repositories: members.map((member) => ({
      folder: member.path, mainCheckout: member.repoRoot, commitsSinceBranching: 0, startedFrom: "origin/main",
      behind: { from: "origin/main", commits: 2 },
      pullRequest: { number: 7, state: "open", url: "https://github.com/o/r/pull/7", checks: "failed" },
    })),
  }, "each repository's branch stands on its own")
  const review = (path: string, commits: number, merge: WorktreeReview["merge"]): WorktreeReview =>
    ({ path, branch: "mako/thread", into: "main", base: worktree.base, commits, files: [], merge, behind: null })
  reviews.set(members[0]!.path, review(members[0]!.path, 1, { ok: false, reason: "It conflicts with main." }))
  reviews.set(members[1]!.path, review(members[1]!.path, 2, { ok: true, into: "main" }))
  const refusedMerge = await agent.callTool({ name: "worktree_merge", arguments: {} })
  assert.equal(refusedMerge.isError, true)
  assert.equal(text(refusedMerge), "Nothing was merged. api: It conflicts with main.")
  assert.deepEqual(mergedPaths, [worktreePath], "one repository's refusal merges none of them")
  reviews.set(members[0]!.path, review(members[0]!.path, 0, { ok: false, reason: "Nothing is committed here that main doesn't have." }))
  assert.equal(text(await agent.callTool({ name: "worktree_merge", arguments: {} })), "Merged mako/thread in web into main. The branch and this Thread's worktree are still there.")
  assert.deepEqual(mergedPaths, [worktreePath, members[1]!.path], "a repository with nothing committed is left out")
  assert.match(text(await agent.callTool({ name: "worktree_remove", arguments: {} })), new RegExp(`^Removed this Thread's worktree, ${checkoutPath}\\. .* kept with everything committed on it in each repository\\.$`))
  assert.deepEqual(removedPaths, [worktreePath, members[0]!.path], "removing any of a project's worktrees removes its checkout")
  projectCheckout = undefined

  // Before a move, a project folder of several repositories is the main checkout, not "a folder outside Git".
  placed = undefined
  const many = join(root, "many")
  for (const name of ["api", "web"]) {
    const repository = join(many, name)
    mkdirSync(repository, { recursive: true })
    git(repository, "init", "-q", "-b", "main")
    writeFileSync(join(repository, ".gitignore"), "local.env\n")
    git(repository, "add", ".")
    git(repository, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one")
  }
  writeFileSync(join(many, "api", "local.env"), "TOKEN=fixture-only")
  writeFileSync(join(many, "web", "draft.txt"), "draft")
  sources.set("g", { ...sources.get("g")!, cwd: many })
  const ofFolder = parseYaml(text(await agent.callTool({ name: "worktree_status", arguments: {} })))
  assert.equal(ofFolder.editsIn, "the main checkout", "a project folder is its own main checkout, which worktree_move can leave")
  assert.deepEqual(ofFolder.repositories, ["api", "web"])
  assert.equal(ofFolder.uncommittedFiles, 1)
  assert.equal(ofFolder.ignoredInMain.folder, many)
  assert.ok(ofFolder.ignoredInMain.paths.includes("api/local.env"), "its ignored files are listed for bringing along")
  assert.match(listed.find((tool) => tool.name === "worktree_move")!.description!, /several repositories/)
  assert.match(listed.find((tool) => tool.name === "worktree_move")!.description!, /the Thread's other Sessions in this checkout move together/)

  grants.revoke("binding", "g")
  await assert.rejects(agent.listTools(), { code: 401 })
  console.log("Workspace moves: ask, allow once or for the project, move at turn end with the whole Thread, the person's own move with its short wait and refusal, decline, failure, closed conversations; worktree tools over HTTP MCP scoped to the calling conversation")
} finally {
  await agent.close().catch(() => {})
  grants?.close()
  rmSync(root, { recursive: true, force: true })
}
