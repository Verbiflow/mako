import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ORCHESTRATION_INSTRUCTIONS } from "@mako/host/contracts/agent-tools"
import { ALWAYS_LOADED_TOOLS, MAKO_THREAD_SERVER, withoutInstructions } from "@mako/host/contracts/mcp-reach"
import { MAKO_SERVER_INSTRUCTIONS, primerBlocks, primerText } from "@mako/host/contracts/primer"
import { REPORT_FOLLOW_UP_INSTRUCTIONS } from "@mako/host/contracts/report-actions"
import { makoNote } from "@mako/host/conversations/mako-note"
import { registerAgentTools } from "@mako/host/conversations/agent-tools"
import { registerThreadTools } from "@mako/host/conversations/thread-move-tool"
import { codexLayer } from "@mako/host/harnesses/codex/layer"
import { DEVIN_LAYER } from "@mako/host/harnesses/devin/layer"
import { layerOf } from "@mako/host/harnesses/mako-layer"
import { MAKO_INSTRUCTIONS, startConversationMcp } from "@mako/host/tools/conversation-mcp"

/*
 * The `mako` server's instructions reach every harness whole only while they fit the shortest cut a harness makes:
 * Claude Code shows server instructions up to 4,096 characters and drops the rest (code.claude.com/docs/en/mcp, "Tool
 * search for MCP server authors"). Past it, Claude agents never saw the second half, the Fins' rules among it. Grok
 * cuts at about 2,047 characters, so the Fins' rules come first. What doesn't fit goes in the description of the tool
 * it governs, which loads whole when the tool is used.
 */
const CLAUDE_INSTRUCTIONS_CUT = 4_096
const GROK_INSTRUCTIONS_CUT = 2_047

assert.equal(MAKO_INSTRUCTIONS, MAKO_SERVER_INSTRUCTIONS)
assert.ok(MAKO_INSTRUCTIONS.length <= CLAUDE_INSTRUCTIONS_CUT, `MAKO_INSTRUCTIONS is ${MAKO_INSTRUCTIONS.length} characters; Claude cuts at ${CLAUDE_INSTRUCTIONS_CUT}. Move detail into the tool descriptions.`)
assert.ok(ORCHESTRATION_INSTRUCTIONS.length <= CLAUDE_INSTRUCTIONS_CUT, "mako mcp's instructions fit too")
// What must survive the cut, wherever it sits in the text.
for (const rule of [
  "MAKO_NATIVE=1",
  "After starting, end your turn: reports wake you.",
  "`forward: true`",
  "`agents_move`",
  "call `agents_report`",
  "`waitingOn`",
  "never gh --watch",
  "`scope: apexes`",
  "thread_move: ",
  "That's this Thread going on elsewhere, not new work for a Fin",
  "end your turn: Mako wakes you",
  "`decides`",
  // #827's reporting rules: what's ready for review or waits on someone is a result, and a turn ending on progress is one.
  "Ready for review, or waiting on your Apex or the person, is done with an `action`, never progress",
  "progress is for a turn that goes on",
  "a turn ending on progress nothing will wake tells your Apex it ended unfinished",
  "`mode: \"wait\"`",
  "If you poll gh yourself: at most once a minute per repository; after a 403/429 stop all GitHub calls until Retry-After.",
  "an agent CLI with nohup, which can't report or ask",
  "wait: to wait on your Fins",
]) assert.ok(MAKO_INSTRUCTIONS.includes(rule), `the instructions say ${JSON.stringify(rule.slice(0, 60))}`)
// Grok reads only the start: every Fin rule and the wait rule sit inside its cut.
const grokSees = MAKO_INSTRUCTIONS.slice(0, GROK_INSTRUCTIONS_CUT)
for (const rule of ["call `agents_report`", "Several independent reviews, modules or repos: one Fin each, this turn; nothing under 15 minutes, and one feature or bug is one Fin, or yours.", "behind a tool search, search for it", "`waitingOn`", "`agents_move`", "`forward: true`", "`scope: apexes`", "wait: to wait on your Fins", "Never poll or sleep.", "goes through `agents_start`, not your harness's own subagent tool", "never gh --watch"])
  assert.ok(grokSees.includes(rule), `Grok's cut keeps ${JSON.stringify(rule)}`)

// Each fact once: the routes are the primer's, the follow-up rule the Fin's brief's and agents_report's.
const primer = primerText({ role: "thread", noRecipe: false, computer: true })
for (const route of ["worktree_move", "pull_request_open", "never a server started by hand", "recipe_save", "port_holder", "Prefer show", "Prefer thread_history"]) {
  assert.ok(primer.includes(route), `the primer says ${route}`)
  assert.equal(MAKO_INSTRUCTIONS.includes(route), false, `the server's instructions don't repeat ${route}`)
}
assert.equal(MAKO_INSTRUCTIONS.includes(REPORT_FOLLOW_UP_INSTRUCTIONS), false, "the follow-up rule is the brief's and agents_report's")
const startsALine = (text: string) => MAKO_INSTRUCTIONS.split("\n").some((line) => line.startsWith(text))
assert.ok(MAKO_INSTRUCTIONS.startsWith("Mako's tools for the Thread this Session belongs to."), "it opens with what the server is for")
for (const family of ["thread_move", "wait"])
  assert.ok(startsALine(`${family}: `), `a line says what ${family} is for`)
// The words every tool uses, each defined on a line of its own, with the tool family that acts on it.
for (const word of ["main checkout", "worktree", "checkout", "project folder", "app", "recipe", "pull request"])
  assert.ok(startsALine(`- ${word}: `), `the instructions define "${word}"`)
for (const family of ["worktree_*", "app_*", "recipe_*", "pull_request_*"])
  assert.ok(MAKO_INSTRUCTIONS.includes(family), `the words name ${family}`)

// Who hears the server's instructions where. Codex is served `mako` without them and hears them once in its
// developer context; every other harness reads the server as it is.
const tools = { token: "t", computerUrl: "http://127.0.0.1:1/computer", makoUrl: "http://127.0.0.1:1/mako" }
const layer = layerOf({ conversationTools: tools })
const codex = codexLayer.apply(layer, "c")
assert.equal(codex.servers.find((server) => server.name === MAKO_THREAD_SERVER)?.url, withoutInstructions(tools.makoUrl), "Codex's mako URL asks for no instructions")
assert.equal(codex.servers.find((server) => server.name !== MAKO_THREAD_SERVER)?.url, tools.computerUrl, "mako-computer is untouched")
assert.deepEqual(Object.values(codex.instructions ?? {}), [...primerBlocks({ role: "thread", noRecipe: false, computer: true }).map((block) => block.text), MAKO_SERVER_INSTRUCTIONS], "Codex's developer context carries the server's instructions once, each block an entry of its own")
assert.deepEqual(layer.servers.map((server) => server.url), [tools.computerUrl, tools.makoUrl], "the layer every other harness reads keeps the plain URL")
const off = codexLayer.apply(layerOf({ conversationTools: tools, primer: false }), "c")
assert.equal(off.servers.find((server) => server.name === MAKO_THREAD_SERVER)?.url, tools.makoUrl, "with no primer Codex reads them from the server")
// Devin never shows the model a server's instructions, so its note carries them; Cursor and Grok read the server.
assert.equal(DEVIN_LAYER.serverInstructions?.kind, "unread")
const standing = async (serverUnread: boolean) => {
  const note = await makoNote({ cloudMachine: false, launchedWith: () => undefined, controlLine: () => undefined, ownSlot: () => false, serverUnread: () => serverUnread, notices: () => [] })("b", "c", { role: "thread" })
  return note.standing
}
assert.equal((await standing(true))["server"], MAKO_SERVER_INSTRUCTIONS, "Devin's note carries the server's instructions")
assert.equal((await standing(false))["server"], undefined, "a harness that reads the server hears them there only")

// Over HTTP, as the harnesses connect: the plain URL serves the instructions, Codex's serves none.
const door = { invoke: async () => ({}), caller: () => ({ kind: "person" as const }), filled: () => ({}) }
const servers = await startConversationMcp({ authorizeAgent() {} }, async () => ({ content: [] }), [
  (server, _id, conversation) => registerAgentTools(server, door, conversation === undefined ? undefined : "fin"),
  (server) => registerThreadTools(server, door),
])
try {
  const grant = servers.mint("binding", "conversation")
  const instructionsAt = async (url: string) => {
    const client = new Client({ name: "instructions-check", version: "1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
    try {
      return client.getInstructions()
    } finally {
      await client.close()
    }
  }
  assert.equal(await instructionsAt(grant.makoUrl!), MAKO_INSTRUCTIONS, "Claude, Cursor, Grok, OpenCode and Devin are served the instructions")
  assert.equal(await instructionsAt(withoutInstructions(grant.makoUrl!)), undefined, "Codex's connection carries no instructions")
  // The tools an agent must never have to look up are in Claude's prompt from the first turn, never behind its tool search.
  const lister = new Client({ name: "instructions-check", version: "1" })
  await lister.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl!), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
  try {
    const listed = (await lister.listTools()).tools
    const loaded = listed.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true).map((tool) => tool.name).toSorted()
    assert.deepEqual(loaded, [...ALWAYS_LOADED_TOOLS].filter((name) => listed.some((tool) => tool.name === name)).toSorted(), "each always-loaded tool listed is tagged, and only those")
    for (const name of ALWAYS_LOADED_TOOLS) assert.ok(loaded.includes(name), `${name} is always loaded`)
  } finally {
    await lister.close()
  }
  const [here, there] = InMemoryTransport.createLinkedPair()
  const inProcess = await grant.makoServer!()
  const reader = new Client({ name: "instructions-check", version: "1" })
  await inProcess.connect(here)
  await reader.connect(there)
  assert.equal(reader.getInstructions(), MAKO_INSTRUCTIONS, "Claude's in-process server keeps them")
  await reader.close()
} finally {
  servers.close()
}
process.stdout.write(`mako instructions: ${MAKO_INSTRUCTIONS.length} of ${CLAUDE_INSTRUCTIONS_CUT} characters, the Fins' rules inside Grok's ${GROK_INSTRUCTIONS_CUT}; Codex served without them\n`)
