import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import type { ThreadWorktree } from "../electron/contracts/thread-worktrees.js"
import type { WorkspaceMoves as WorkspaceMovesState } from "../electron/contracts/workspace-moves.js"
import { MAKO_COMPUTER_SERVER, MAKO_THREAD_SERVER } from "../electron/contracts/mcp-reach.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { WorkspaceMoves, type MoveSource } from "../electron/workspace-moves.js"
import { moveablePlace, workspaceTools } from "../electron/workspace-tools.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-workspace-moves-")))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const agent = new Client({ name: "workspace-agent", version: "1" })
let grants: Awaited<ReturnType<typeof startConversationMcp>> | undefined

try {
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
  const worktree: ThreadWorktree = { path: worktreePath, thread: "t", repoRoot: project, project, branch: "mako/thread", base: git(project, "rev-parse", "HEAD") }

  let placed: ThreadWorktree | undefined
  const removedPaths: string[] = []
  const worktrees = {
    ofConversation: () => placed,
    ahead: async () => 0,
    merge: async () => ({ branch: worktree.branch, into: "main" }),
    remove: async (path: string) => {
      removedPaths.push(path)
      return { root, worktrees: [] }
    },
  }

  assert.deepEqual(await moveablePlace(worktrees, "c", project), { project, changed: 2 }, "a new worktree takes the checkout's uncommitted files")
  assert.deepEqual(await moveablePlace(worktrees, "c", join(root)), { refused: "This folder isn't in a Git repository, so there's no branch to move onto." })
  assert.deepEqual(await moveablePlace(null, "c", project), { refused: "Worktrees need the Thread store, which didn't open." })
  placed = worktree
  assert.deepEqual(await moveablePlace(worktrees, "c", project), { project, joins: "mako/thread", changed: 0 }, "a Thread with a worktree is joined and nothing moves")
  const inside = await moveablePlace(worktrees, "c", worktreePath)
  assert.ok("refused" in inside)
  assert.match(inside.refused, /already works on its own branch, mako\/thread/)
  placed = undefined

  // The request's life: asked, answered once or for the project, carried out when the turn ends.
  const file = join(root, "userData", "workspace-moves.json")
  const sources = new Map<string, MoveSource>([["c", { cwd: project, harness: "claude", title: "Fix the tests", busy: true }]])
  const announced: WorkspaceMovesState[] = []
  const moved: string[] = []
  const failures: string[] = []
  const deps = {
    file,
    source: (id: string) => sources.get(id),
    place: (id: string, cwd: string) => moveablePlace(worktrees, id, cwd),
    move: async (id: string) => {
      moved.push(id)
      if (id === "broken") throw new Error("prepare failed")
    },
    announce: (state: WorkspaceMovesState) => announced.push(state),
    failed: (_id: string, message: string) => failures.push(message),
  }
  const moves = new WorkspaceMoves(deps)
  assert.match(await moves.ask("c"), /^Asked the user\..*uncommitted files in this folder/s)
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

  await assert.rejects(moves.ask("gone"), /isn't running this conversation/)
  sources.delete("e")
  assert.equal(moves.state().requests.some((candidate) => candidate.conversationId === "e"), false, "a closed conversation's request goes")

  // The tools, over the conversation's real HTTP MCP server, act on the calling conversation only.
  const removed: number[] = []
  const tools = workspaceTools({ cwd: (id) => sources.get(id)?.cwd, worktrees, moves, removed: () => removed.push(1) })
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
  assert.deepEqual(listed.map((tool) => tool.name), ["workspace_status", "workspace_move", "workspace_merge", "workspace_remove"])
  assert.match(agent.getInstructions() ?? "", /^Mako's tools for the Thread this Session belongs to\./, "the mako server says what it's for")
  // Each client numbers its own requests, so the same number on both servers is two different calls.
  const slow = computer.callTool({ name: "js", arguments: { code: "1" } })
  await delay(100)
  const concurrent = await agent.callTool({ name: "workspace_status", arguments: {} })
  assert.equal(concurrent.isError, undefined, "a call on one server doesn't block the same request number on the other")
  releaseComputer()
  await slow
  await computer.close()
  assert.match(listed.find((tool) => tool.name === "workspace_move")!.description!, /instead of `git worktree add`/)
  assert.equal(listed.find((tool) => tool.name === "workspace_status")!.annotations?.readOnlyHint, true)
  assert.equal(listed.find((tool) => tool.name === "workspace_remove")!.annotations?.destructiveHint, true)
  const text = (result: Awaited<ReturnType<typeof agent.callTool>>) => {
    const [first] = z.array(z.object({ text: z.string() })).parse(result.content)
    assert.ok(first)
    return first.text
  }

  const status = JSON.parse(text(await agent.callTool({ name: "workspace_status", arguments: {} })))
  assert.deepEqual(status, { makesChangesIn: "the project folder", folder: project, branch: "main", uncommittedFiles: 2 })
  const merge = await agent.callTool({ name: "workspace_merge", arguments: {} })
  assert.equal(merge.isError, true)
  assert.match(text(merge), /has no branch of its own/)

  const asked = await agent.callTool({ name: "workspace_move", arguments: {} })
  assert.equal(asked.isError, undefined)
  assert.match(text(asked), /^Asked the user/)
  assert.equal(moves.state().requests.find((candidate) => candidate.conversationId === "g")?.harness, "claude")
  assert.equal(JSON.parse(text(await agent.callTool({ name: "workspace_status", arguments: {} }))).move, "asking")

  placed = worktree
  sources.set("g", { ...sources.get("g")!, cwd: worktreePath })
  const onBranch = JSON.parse(text(await agent.callTool({ name: "workspace_status", arguments: {} })))
  assert.equal(onBranch.makesChangesIn, "its own branch")
  assert.deepEqual(onBranch.threadBranch, { branch: "mako/thread", worktree: worktreePath, project, commitsSinceBranching: 0 })
  assert.match(text(await agent.callTool({ name: "workspace_merge", arguments: {} })), /^Merged mako\/thread into main/)
  assert.match(text(await agent.callTool({ name: "workspace_remove", arguments: {} })), /^Removed the worktree .* its branch, mako\/thread, is kept/is)
  assert.deepEqual(removedPaths, [worktreePath])
  assert.deepEqual(removed, [1], "windows are told to read the worktrees again")

  grants.revoke("binding", "g")
  await assert.rejects(agent.listTools(), { code: 401 })
  console.log("Workspace moves: ask, allow once or for the project, move at turn end, decline, failure, closed conversations; workspace tools over HTTP MCP scoped to the calling conversation")
} finally {
  await agent.close().catch(() => {})
  grants?.close()
  rmSync(root, { recursive: true, force: true })
}
