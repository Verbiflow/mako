import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { JsonValue } from "@mako/host/contracts/json"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Entry } from "@mako/sessions/entries"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { identifyTool } from "@mako/sessions/tool-identity"
import { callMedia, MEDIA_META, mediaDetails, mediaKind, SHOW_MEDIA_LINE, turnMedia } from "@mako/sessions/turn-media"
import { ClaudeProjection } from "../packages/sessions/src/claude-projection.ts"
import { ClaudeProvider } from "../packages/sessions/src/providers/claude.ts"
import { CodexRecords } from "../packages/sessions/src/providers/codex-records.ts"
import { acpToolFields } from "../packages/sessions/src/acp-tool-details.ts"
import { MEDIA_META as COMPUTER_MEDIA_META, controlAgent } from "../packages/control-runtime/src/control-agent.ts"
import { producedMedia } from "../packages/control/src/program/runtime.ts"
import { registerShowTool, TurnMedia } from "../packages/host/src/media/index.ts"
import { entriesToMessages } from "../src/lib/entry-messages.ts"
import { exchangeMedia, responseSections, toExchanges } from "../src/lib/exchanges.ts"
import { proseMediaSpellings, shelfMedia } from "../src/lib/media-shelf.ts"
import { turnFolds } from "../src/lib/turn-fold.ts"
import { foldTools } from "../src/lib/tools.ts"

/**
 * What a turn produced, read from its records the same way live and saved
 * (`turn-media.ts`), confirmed and kept by the host (`TurnMedia`), shown by
 * `show`, and drawn by the transcript: the shelf under the answer and
 * `show`'s media where it was called. The decode pairs hold every recorded
 * harness's live and saved media lines to each other (`decode-compare.ts`);
 * this holds each source to what it means.
 */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEklEQVR4nGP8z8DAwMDAxMDAAAAPjAEHZgCeVQAAAABJRU5ErkJggg==", "base64")
const root = await mkdtemp(join(tmpdir(), "mako-turn-media-"))
const shots = join(root, "shots")
await mkdir(shots)

// Kinds: media only, never text.
assert.equal(mediaKind("/a/b/Home.PNG"), "image")
assert.equal(mediaKind("/a/flow.mp4"), "video")
assert.equal(mediaKind("/a/report.html"), "html")
assert.equal(mediaKind("/a/notes.pdf"), "pdf")
assert.equal(mediaKind("/a/.png"), undefined, "a dotfile is no image")
assert.equal(mediaKind("/home/me/.ssh/id_rsa"), undefined)
assert.equal(mediaKind("/a/notes.md"), undefined)

// `_meta` reads only Mako's key, only absolute media paths.
assert.deepEqual(mediaDetails({ other: 1 }), [])
assert.deepEqual(mediaDetails({ [MEDIA_META]: { via: "show", files: [{ path: "/a/notes.txt" }] } }), [])
assert.deepEqual(mediaDetails({ [MEDIA_META]: { via: "show", title: "Sign-in", files: [{ path: "/a/home.png", caption: "Home" }, { path: "relative.png" }] } }), [])
assert.deepEqual(mediaDetails({ [MEDIA_META]: { via: "show", title: "Sign-in", files: [{ path: "/a/home.png", caption: "Home" }, { path: "/a/notes.txt" }] } }),
  [{ type: "media", via: "show", title: "Sign-in", files: [{ path: "/a/home.png", caption: "Home" }] }])
assert.equal(COMPUTER_MEDIA_META, MEDIA_META, "mako-computer states its files under the key the transcript reads")

// Each source, strongest first.
const command: Extract<Entry, { type: "tool" }> = {
  type: "tool", id: "cmd", name: "Bash", status: "completed", at: 1_000, endedAt: 2_000,
  input: JSON.stringify({ command: "screencapture -x /tmp/shots/home.png && cat README.md" }),
  effects: [{ kind: "command", command: "screencapture -x /tmp/shots/home.png", named: ["/tmp/shots/home.png", "/repo/README.md"] }],
}
assert.deepEqual(callMedia(command).map(({ evidence, path, startedAt, endedAt }) => ({ evidence, path, startedAt, endedAt })),
  [{ evidence: "named", path: "/tmp/shots/home.png", startedAt: 1_000, endedAt: 2_000 }], "a command names evidence; its README is no media")
const write: Extract<Entry, { type: "tool" }> = { type: "tool", id: "w", name: "Write", status: "completed", effects: [{ kind: "create", path: "/repo/report.html" }, { kind: "create", path: "/repo/notes.md" }] }
assert.deepEqual(callMedia(write).map((media) => [media.evidence, media.kind, media.path]), [["wrote", "html", "/repo/report.html"]])
assert.deepEqual(callMedia({ ...write, status: "failed" }), [], "a failed call made nothing")
const image = { type: "attachment" as const, name: "image", mimeType: "image/png", source: { kind: "inline" as const, data: PNG.toString("base64") } }
const read: Extract<Entry, { type: "tool" }> = { type: "tool", id: "r", name: "Read", status: "completed", attachments: [image], effects: [{ kind: "read", path: "/tmp/shots/home.png" }] }
const readIdentity = identifyTool({ harness: "claude", name: "Read" })
assert.deepEqual(callMedia(read, readIdentity).map((media) => [media.evidence, media.path, media.viewed]), [["attached", "/tmp/shots/home.png", true]])
assert.deepEqual(turnMedia([read], "claude"), [], "an image the agent only looked at is not the turn's")
const merged = turnMedia([command, read], "claude")
assert.equal(merged.length, 1, "the screenshot it took and then read is one file")
assert.equal(merged[0]!.evidence, "attached", "with the bytes the read returned")
assert.equal(merged[0]!.attachment, image)
const screenshotTool: Extract<Entry, { type: "tool" }> = { type: "tool", id: "pw", name: "mcp__playwright__browser_take_screenshot", status: "completed", attachments: [image] }
assert.deepEqual(callMedia(screenshotTool, identifyTool({ harness: "claude", name: screenshotTool.name })).map((media) => [media.evidence, media.key]), [["attached", "pw#0"]])

// `show` without `_meta`, named and wrapped as each harness does.
const showInput = { files: [{ path: "/tmp/shots/home.png", caption: "Home after sign-in" }, { path: "/tmp/flow.mp4" }], title: "Sign-in flow" }
const wrapped: [string, { name: string; input: string }][] = [
  ["claude", { name: "mcp__mako__show", input: JSON.stringify(showInput) }],
  ["codex", { name: "mako.show", input: JSON.stringify(showInput) }],
  ["opencode", { name: "execute", input: JSON.stringify({ code: `await tools.mako.show(${JSON.stringify(showInput)})` }) }],
  ["cursor", { name: "mcp", input: JSON.stringify({ providerIdentifier: "mako", toolName: "show", args: showInput }) }],
  ["grok", { name: "use_tool", input: JSON.stringify({ tool_name: "mcp__mako__show", tool_input: showInput }) }],
]
for (const [harness, call] of wrapped) {
  const entry: Extract<Entry, { type: "tool" }> = { type: "tool", id: "s", status: "completed", ...call }
  const media = turnMedia([entry], harness)
  // A code-mode script is read for its paths; its captions stay in the script.
  const script = harness === "opencode"
  assert.deepEqual(media.map((candidate) => [candidate.evidence, candidate.path, candidate.caption, candidate.title]), [
    ["shown", "/tmp/shots/home.png", script ? undefined : "Home after sign-in", script ? undefined : "Sign-in flow"],
    ["shown", "/tmp/flow.mp4", undefined, script ? undefined : "Sign-in flow"],
  ], `${harness} ${call.name}: show is found by what it is, not its name`)
}

// Claude: `_meta` live (the SDK's `mcp_meta`) and saved (the transcript's `mcpMeta`) read the same.
const report = { via: "show", title: "Sign-in flow", files: [{ path: "/tmp/shots/home.png", caption: "Home after sign-in", digest: "a".repeat(64) }] }
const projection = new ClaudeProjection()
// SAFETY: each literal below is an SDK message as Claude Code streams it; the projection reads only the fields it sets.
const sdk = (message: Record<string, JsonValue>) => message as SDKMessage
const liveUpdates: LiveUpdate[] = [
  { kind: "user", text: "Show me the sign-in page" },
  ...projection.project(sdk({ type: "assistant", uuid: "a1", session_id: "s", parent_tool_use_id: null, message: { id: "m1", model: "claude", content: [
    { type: "tool_use", id: "toolu_show", name: "mcp__mako__show", input: { files: [{ path: "/elsewhere.png" }] } },
    { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/shots/home.png" } },
  ] } })),
  ...projection.project(sdk({ type: "user", uuid: "u1", session_id: "s", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_show", content: [{ type: "text", text: "Shown" }] }] }, mcp_meta: { _meta: { [MEDIA_META]: report } } })),
  ...projection.project(sdk({ type: "user", uuid: "u2", session_id: "s", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }] }] } })),
]
const liveEntries = reduceLiveUpdates([], liveUpdates)
const liveRead = liveEntries.find((entry) => entry.type === "tool" && entry.id === "toolu_read")
assert.equal(liveRead?.type === "tool" && liveRead.attachments?.[0]?.name, "home.png", "Claude's Read image is named for the file it read")
const claudeHome = join(root, "claude-home")
const project = join(claudeHome, ".claude", "projects", "-tmp-project")
await mkdir(project, { recursive: true })
const line = (record: Record<string, JsonValue>) => JSON.stringify({ isSidechain: false, sessionId: "f2d1c9a0-0000-4000-8000-000000000001", cwd: "/tmp/project", version: "2.1.310", timestamp: "2026-10-25T10:00:00.000Z", ...record })
await writeFile(join(project, "f2d1c9a0-0000-4000-8000-000000000001.jsonl"), [
  line({ type: "user", uuid: "p", parentUuid: null, message: { role: "user", content: [{ type: "text", text: "Show me the sign-in page" }] } }),
  line({ type: "assistant", uuid: "a1", parentUuid: "p", message: { id: "m1", type: "message", role: "assistant", model: "claude", content: [{ type: "tool_use", id: "toolu_show", name: "mcp__mako__show", input: { files: [{ path: "/elsewhere.png" }] } }] } }),
  line({ type: "user", uuid: "u1", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_show", content: [{ type: "text", text: "Shown" }] }] }, toolUseResult: [{ type: "text", text: "Shown" }], mcpMeta: { _meta: { [MEDIA_META]: report } } }),
  line({ type: "assistant", uuid: "a2", parentUuid: "u1", message: { id: "m2", type: "message", role: "assistant", model: "claude", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/shots/home.png" } }] } }),
  line({ type: "user", uuid: "u2", parentUuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }] }] } }),
].join("\n") + "\n")
const saved = await new ClaudeProvider(claudeHome).read(join(project, "f2d1c9a0-0000-4000-8000-000000000001.jsonl"))
assert.ok(saved)
const shownOf = (entries: readonly Entry[]) => turnMedia(entries, "claude").map(({ evidence, path, caption, digest, title }) => ({ evidence, path, caption, digest, title }))
assert.deepEqual(shownOf(saved.entries), shownOf(liveEntries), "Claude: live and saved find the same media")
assert.deepEqual(shownOf(liveEntries), [{ evidence: "shown", path: "/tmp/shots/home.png", caption: "Home after sign-in", digest: "a".repeat(64), title: "Sign-in flow" }],
  "the result's `_meta` outranks the call's arguments")

// Codex: a code cell's `show` keeps its `_meta` and its image, not `[image]`.
const codex = new CodexRecords()
const rollout = [
  { type: "session_meta", payload: { id: "01a1727a-9e2b-75d0-bffe-0d195009101c", timestamp: "2026-10-25T09:53:20.941Z", cwd: "/tmp/project", cli_version: "0.164.0" } },
  { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the sign-in page" }] } },
  { type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "call_1", name: "exec", input: "await tools.mako.show({ files: [{ path: \"/tmp/shots/home.png\" }] })" } },
  { type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "McpToolCall", id: "exec-1", server: "mako", tool: "show", arguments: { files: [{ path: "/tmp/shots/home.png" }] }, status: "completed",
    result: { content: [{ type: "text", text: "Shown" }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], _meta: { [MEDIA_META]: report } } } } },
  { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }] } },
].map((record, index) => JSON.stringify({ timestamp: `2026-10-25T09:53:2${index}.000Z`, ...record }))
const codexEntries = reduceLiveUpdates([], rollout.flatMap((text) => codex.line(text)).flatMap((read) => (read.kind === "update" ? [read.update] : [])))
const nested = codexEntries.find((entry) => entry.type === "tool" && entry.id === "exec-1")
assert.ok(nested?.type === "tool")
assert.equal(nested.output, "Shown", "an image part is no `[image]` text")
assert.equal(nested.attachments?.[0]?.mimeType, "image/png", "Codex keeps a nested call's image")
assert.deepEqual(turnMedia(codexEntries, "codex").map(({ evidence, caption }) => [evidence, caption]), [["shown", "Home after sign-in"]])

// ACP: an agent that hands on the whole MCP result keeps its `_meta`.
assert.deepEqual(acpToolFields({ status: "completed", rawOutput: { content: [], _meta: { [MEDIA_META]: report } } }).details?.[0]?.type, "media")

// mako-computer states the files a cell made.
assert.deepEqual(producedMedia({ action: "screenshot", screenshot_out_file: "/tmp/shots/a.png" }, { width: 10 }), ["/tmp/shots/a.png"])
assert.deepEqual(producedMedia({ action: "recording" }, { receipt: { status: "finished", video: "/tmp/rec/flow.mp4", timeline: "/tmp/rec/timeline.json" } }), ["/tmp/rec/flow.mp4"])
assert.deepEqual(producedMedia({ action: "download" }, { path: "relative.png", note: "/tmp/x.png" }), [], "only absolute paths under a file's key")
const js = controlAgent({
  execute: async (_input, _signal, execution) => {
    execution?.report?.({ effects: [], files: ["/tmp/rec/flow.mp4"] })
    return [{ type: "text", text: "done" }]
  },
  resetProgram: async () => {},
})
const jsResult = await js({ method: "js", code: "return 1" }, new AbortController().signal)
assert.deepEqual(mediaDetails(z.object({ _meta: z.json() }).parse(jsResult)._meta), [{ type: "media", via: "produced", files: [{ path: "/tmp/rec/flow.mp4" }] }])

// The host: confirmed against the disk, kept by content, answered by call.
const media = new TurnMedia(join(root, "store"))
const home = join(shots, "home.png")
await writeFile(home, PNG)
const made = (await import("node:fs/promises")).stat
const mtime = (await made(home)).mtimeMs
const [kept, old, txt, missing, running] = await media.confirm([
  { callId: "c1", path: home, evidence: "named", startedAt: Math.round(mtime) - 500, endedAt: Math.round(mtime) + 500 },
  { callId: "c2", path: home, evidence: "named", startedAt: Math.round(mtime) + 60_000, endedAt: Math.round(mtime) + 61_000 },
  { callId: "c3", path: join(shots, "notes.txt"), evidence: "wrote", endedAt: 1 },
  { callId: "c4", path: join(shots, "gone.png"), evidence: "wrote", startedAt: 1, endedAt: 2 },
  { callId: "c5", path: join(shots, "later.png"), evidence: "wrote", startedAt: Date.now() },
])
assert.equal(kept?.kind, "kept")
assert.ok(kept?.kind === "kept" && kept.media.file !== home && kept.media.digest, "a kept file is Mako's copy")
assert.ok(kept?.kind === "kept" && kept.media.width === 2 && kept.media.height === 3, "with its size in pixels")
assert.equal(old?.kind, "dropped", "a file the command only named, unchanged while it ran, isn't the turn's")
assert.equal(txt?.kind, "dropped", "text is never media")
assert.equal(missing?.kind, "dropped")
assert.equal(running?.kind, "pending", "a running call's file may yet come")
// The turn keeps what it made after the agent overwrites it, or /tmp loses it.
await writeFile(home, Buffer.concat([PNG, Buffer.from("later")]))
await utimes(home, new Date(), new Date(Date.now() + 120_000))
const [again] = await media.confirm([{ callId: "c1", path: home, evidence: "named", startedAt: Math.round(mtime) - 500, endedAt: Math.round(mtime) + 500 }])
assert.deepEqual(again, kept, "answered from the store, not the disk")
assert.ok(again?.kind === "kept" && (await readFile(again.media.file)).equals(PNG), "the copy holds the turn's bytes")
const [changed] = await media.confirm([{ callId: "c6", path: home, evidence: "wrote", startedAt: 1, endedAt: Math.round(mtime) + 500 }])
assert.equal(changed?.kind, "dropped", "a file changed since its call ended was not kept in time")
await rm(home)
// `show` keeps a copy now; a harness that kept no `_meta` finds it by path and time.
const page = join(shots, "report.html")
await writeFile(page, "<!doctype html><h1>Report</h1>")
const shownAt = Date.now()
const shown = await media.show(page)
await writeFile(page, "<!doctype html><h1>Changed</h1>")
const [byTime, byDigest] = await media.confirm([
  { callId: "s1", path: page, evidence: "shown", startedAt: shownAt - 100, endedAt: Date.now() },
  { callId: "s2", path: page, evidence: "shown", digest: shown.digest!, endedAt: 1 },
])
assert.ok(byTime?.kind === "kept" && byTime.media.digest === shown.digest)
assert.ok(byDigest?.kind === "kept" && (await readFile(byDigest.media.file, "utf8")).includes("Report"), "the page as it was shown")
await assert.rejects(media.show(join(shots, "notes.txt")), /isn't an image/)

// `show` over MCP: validates, keeps, and states what it showed.
await writeFile(join(shots, "home.png"), PNG)
const server = new McpServer({ name: "mako", version: "1.0.0" })
registerShowTool(server, { media, cwd: () => shots }, () => "conversation")
const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
await server.connect(serverEnd)
const client = new Client({ name: "test", version: "1.0.0" })
await client.connect(clientEnd)
const result = await client.callTool({ name: "show", arguments: { files: [{ path: "home.png", caption: "Home" }], title: "Sign-in" } })
assert.equal(result.isError, undefined)
const stated = mediaDetails(z.json().parse(result._meta ?? null))
assert.deepEqual(stated.map((detail) => detail.type === "media" && detail.files.map((file) => [file.path, file.caption, Boolean(file.digest)])), [[[join(shots, "home.png"), "Home", true]]])
const refused = await client.callTool({ name: "show", arguments: { files: [{ path: "/etc/hosts" }] } })
assert.equal(refused.isError, true, "show refuses anything but media")
await client.close()
media.close()

// The transcript: `show` stands where it was called, the shelf holds the rest.
const turn: Entry[] = [
  { type: "user", text: "Take screenshots of the sign-in flow", id: "p1", at: 1 },
  { ...command, id: "cmd1" },
  { type: "tool", id: "show1", name: "mcp__mako__show", status: "completed", input: JSON.stringify(showInput), at: 3, endedAt: 4 },
  { ...write, id: "w1", effects: [{ kind: "create", path: "/repo/report.html" }, { kind: "create", path: "/repo/out/chart.png" }] },
  { type: "text", text: "Done. The chart is at `/repo/out/chart.png`; the screenshots are saved.", id: "t1" },
]
const [exchange] = toExchanges(foldTools(entriesToMessages(turn, { kind: "saved", provider: "claude" }).messages))
assert.ok(exchange)
const sections = responseSections(exchange.response)
assert.deepEqual(sections.map((section) => section.kind), ["work", "shown", "work", "prose"])
const folds = turnFolds(sections, 1)
assert.deepEqual(folds.map((fold) => fold.kept), [[1]], "a settled turn keeps what it showed in view")
assert.deepEqual(exchangeMedia(exchange).map((candidate) => [candidate.evidence, candidate.path]), [
  ["shown", "/tmp/shots/home.png"], ["shown", "/tmp/flow.mp4"], ["wrote", "/repo/report.html"], ["wrote", "/repo/out/chart.png"],
], "each file once, under the strongest evidence, in the order the turn made them")
assert.deepEqual(proseMediaSpellings("See ![home](/tmp/a.png), `./out/b.mp4`, `c.png` and [d](notes.md)."), ["/tmp/a.png", "out/b.mp4"])
assert.deepEqual(shelfMedia(exchange).map((candidate) => candidate.path), ["/repo/report.html"], "shown and cited files aren't on the shelf twice")
// The same turn live: the same media.
const liveTurn = toExchanges(foldTools(entriesToMessages(turn, { kind: "live", running: false, provider: "claude" }).messages))[0]!
assert.deepEqual(exchangeMedia(liveTurn), exchangeMedia(exchange))

// Every harness hears one line, and it reads plainly.
assert.ok(SHOW_MEDIA_LINE.length < 260 && !SHOW_MEDIA_LINE.includes("\n"))

await rm(root, { recursive: true, force: true })
console.log("PASS: turn media reads the same live and saved for every source and harness shape, the host keeps what each turn made, show states what it showed, and the transcript draws each once")
