import assert from "node:assert/strict"
import { McpSignIns } from "@mako/host/tools/mcp-sign-ins"
import { mcpFailure, mcpServerFailedEvent } from "@mako/sessions/events"
import { codexMcpSource } from "@mako/host/harnesses/codex/mcp"
import { claudeMcpSource } from "@mako/host/harnesses/claude/mcp"
import type { McpSignIns as Reading } from "@mako/host/contracts/mcp-sign-ins"

// The words Codex 0.159 and Claude Code really use read as "sign-in required"; others keep their shared reason.
const reasonOf = (said: string) => mcpFailure(mcpServerFailedEvent("s", said))?.reason
assert.equal(reasonOf("The todoist MCP server is not logged in. Run `codex mcp login todoist`."), "sign-in required")
assert.equal(reasonOf("The linear MCP server requires OAuth reauthentication. Run `codex mcp login linear`."), "sign-in required")
assert.equal(reasonOf("needs authentication"), "sign-in required")
assert.equal(reasonOf("handshaking with MCP server failed: connection closed"), "could not connect")
assert.deepEqual(mcpFailure(mcpServerFailedEvent("claude.ai Gmail", "sign-in required")), { server: "claude.ai Gmail", reason: "sign-in required" })

// Each harness says its own way in: Codex's command, a claude.ai connector's page, nothing for another Claude server.
assert.deepEqual(codexMcpSource.login?.("todoist"), { kind: "command", args: ["mcp", "login", "todoist"] })
assert.deepEqual(claudeMcpSource.login?.("claude.ai Gmail"), { kind: "page", url: "https://claude.ai/settings/connectors" })
assert.equal(claudeMcpSource.login?.("linear"), undefined)

const sources = new Map([["codex", codexMcpSource], ["claude", claudeMcpSource]])
const told: Reading[] = []
const runs: string[][] = []
let finish: (ok: boolean) => void = () => {}
const signIns = new McpSignIns({
  login: (harness, server) => sources.get(harness)?.login?.(server),
  run: (_harness, args) => new Promise((resolve, reject) => { runs.push(args); finish = (ok) => (ok ? resolve() : reject(new Error("exit 1"))) }),
  emit: (reading) => told.push(reading),
  now: () => 1,
})

// Only sign-in it can offer is kept, said once however many sessions report it; the rest is the log's.
signIns.reported({ harness: "codex", server: "todoist", reason: "sign-in required" })
signIns.reported({ harness: "codex", server: "todoist", reason: "sign-in required" })
signIns.reported({ harness: "claude", server: "paper", reason: "could not connect" })
signIns.reported({ harness: "claude", server: "linear", reason: "sign-in required" })
signIns.reported({ harness: "claude", server: "claude.ai Gmail", reason: "sign-in required" })
assert.deepEqual(signIns.snapshot().servers.map(({ harness, server, way }) => [harness, server, way]), [["claude", "claude.ai Gmail", "page"], ["codex", "todoist", "command"]])
assert.equal(told.length, 2, "each server is said when it first needs sign-in, not each time a session reports it")

// A command runs the harness's own login; the server is signing in until it exits, then gone.
await signIns.signIn("codex", "todoist")
assert.deepEqual(runs, [["mcp", "login", "todoist"]])
assert.equal(signIns.snapshot().servers.find(({ server }) => server === "todoist")?.state?.kind, "signing-in")
await signIns.signIn("codex", "todoist")
assert.equal(runs.length, 1, "a second press while it signs in starts nothing")
finish(true)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(signIns.snapshot().servers.some(({ server }) => server === "todoist"), false, "signed in: it clears itself")

// One that fails says so and can be tried again.
signIns.reported({ harness: "codex", server: "linear", reason: "sign-in required" })
await signIns.signIn("codex", "linear")
finish(false)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(signIns.snapshot().servers.find(({ server }) => server === "linear")?.state?.kind, "failed")

// A page is the window's to open: the server clears, and comes back if the harness still can't reach it.
await signIns.signIn("claude", "claude.ai Gmail")
assert.equal(signIns.snapshot().servers.some(({ server }) => server === "claude.ai Gmail"), false)

console.log("MCP sign-ins: the harnesses' own words read as sign-in, each server kept once with its harness's way in, a command clears it once it exits 0 and says when it doesn't, a page clears it; every other failure is the log's")
