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
import type { ThreadWorktree } from "../electron/contracts/thread-worktrees.js"
import type { WorkspaceMoves as WorkspaceMovesState } from "../electron/contracts/workspace-moves.js"
import { MAKO_COMPUTER_SERVER, MAKO_THREAD_SERVER } from "../electron/contracts/mcp-reach.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { WorkspaceMoves, type MoveSource } from "../electron/workspace-moves.js"
import { RECIPE_PATH } from "../electron/thread-recipe.js"
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
  const worktree: ThreadWorktree = { path: worktreePath, thread: ThreadIdSchema.parse(randomUUID()), repoRoot: project, project, branch: "mako/thread", base: git(project, "rev-parse", "HEAD"), createdAt: Date.now() }

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
  assert.ok(inside.refused)
  assert.match(inside.refused, /already edits in this Thread's worktree, .*, on mako\/thread\.$/)
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
  const recipesRoot = join(root, "recipes")
  const tools = workspaceTools({ recipesRoot, cwd: (id) => sources.get(id)?.cwd, worktrees, moves, removed: () => removed.push(1) })
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
  assert.deepEqual(listed.map((tool) => tool.name), ["worktree_status", "worktree_bring", "worktree_move", "worktree_merge", "worktree_remove"])
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
  assert.deepEqual(onBranch.threadWorktree, { folder: worktreePath, branch: "mako/thread", mainCheckout: project, commitsSinceBranching: 0 })
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
  assert.deepEqual(removed, [1], "windows are told to read the worktrees again")

  grants.revoke("binding", "g")
  await assert.rejects(agent.listTools(), { code: 401 })
  console.log("Workspace moves: ask, allow once or for the project, move at turn end, decline, failure, closed conversations; worktree tools over HTTP MCP scoped to the calling conversation")
} finally {
  await agent.close().catch(() => {})
  grants?.close()
  rmSync(root, { recursive: true, force: true })
}
