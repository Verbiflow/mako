// What the rail and Settings › MCP draw of the servers a harness couldn't start, through the production components.
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { McpSignInRailLine, McpSignInsList } from "../src/components/settings/mcp-sign-ins"
import { applyMcpSignIns } from "../src/state/mcp-sign-ins"

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim()

// A Claude server needing sign-in that isn't a claude.ai connector, and a Codex server it couldn't connect to.
applyMcpSignIns({ servers: [
  { harness: "claude", server: "linear", reason: "sign-in required", way: "settings", reportedAt: 1 },
  { harness: "codex", server: "paper", reason: "could not connect", way: "settings", reportedAt: 1 },
] })
const settings = renderToStaticMarkup(<McpSignInsList />)
assert.match(text(settings), /couldn't start linear: sign-in required\. Its entry is below\./)
assert.match(settings, /data-mcp-unreachable="paper"/, "an unreachable server is Settings' quiet status")
assert.match(text(settings), /couldn't reach paper \(could not connect\)\. It tries again with each new session\./)
const rail = renderToStaticMarkup(<McpSignInRailLine />)
assert.match(text(rail), /linear didn't start Open Settings › MCP/, "a server needing sign-in with no way Mako can start opens Settings › MCP")
assert.doesNotMatch(rail, /paper/, "a server only unreachable is Settings' alone")

// One with a sign-in leads the rail with it; the rest are a press away.
applyMcpSignIns({ servers: [
  { harness: "claude", server: "linear", reason: "sign-in required", way: "settings", reportedAt: 1 },
  { harness: "codex", server: "todoist", reason: "sign-in required", way: "command", reportedAt: 1 },
] })
assert.match(text(renderToStaticMarkup(<McpSignInRailLine />)), /^Sign in to todoist 1 more$/)

// Only unreachable servers: nothing in the rail.
applyMcpSignIns({ servers: [{ harness: "codex", server: "paper", reason: "timed out", way: "settings", reportedAt: 1 }] })
assert.equal(renderToStaticMarkup(<McpSignInRailLine />), "")

console.log("MCP lines: Settings says every server that didn't start (unreachable ones quietly), the rail each that needs the person, with its sign-in or Settings › MCP")
