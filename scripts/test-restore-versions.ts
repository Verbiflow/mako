import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessVersions } from "@mako/host/contracts/harness-versions"
import type { HarnessUpdateInfo } from "@mako/host/contracts/harness-updates"
import { RuntimeUpdates } from "@mako/host/harnesses/runtime-updates"
import { scriptInstall, type ProviderUpdateSource } from "@mako/host/harnesses/update-source"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { Git } from "@mako/git"
import { MAKO_PINS, pinnedBy } from "@mako/sessions/record-pins"
import { outdatedOf, outdatedText, restoreGate, type WriterEvidence } from "@mako/sessions/record-writers"
import { carriedBecause, outdatedLine, restoreNotice, returnNotice, updateResolves } from "../src/lib/restore-plan.ts"
import { unreadRowWords, unreadSummary } from "../src/lib/unread-records.ts"
import { registeredHarnessIds } from "./registered-harnesses.ts"

/**
 * Restoring only into the same version or a newer one: what the host reads
 * as the version a restore resumes under on each kind of install, with the
 * update it offers; the version a cloud machine installs for a session's
 * records; and the words the window shows for both.
 */

// What a restore resumes under, and how it's updated, for each channel.
const versions = (tested: string, extra: Partial<HarnessVersions> = {}): HarnessVersions => ({ tested, checked: { on: "2026-10-17", how: "fixture" }, feed: { npm: "fixture" }, ...extra })
const sources: ProviderUpdateSource[] = [
  { provider: "codex", binary: () => null, npmPackage: "@openai/codex", install: [], versions: versions("0.159.3", { oldest: "0.146.0" }) },
  { provider: "grok", binary: () => null, install: [scriptInstall("https://x.ai/cli/install.sh")], versions: versions("1.0.46") },
  { provider: "devin", binary: () => null, install: [], managedBy: [["external_agents", "Zed"]], versions: versions("3000.10.23") },
  { provider: "opencode", binary: () => null, install: [scriptInstall("https://opencode.ai/install")], versions: versions("2.0.27") },
  { provider: "claude", binary: () => null, install: [], versions: versions("2.1.283", { bundled: { package: "@anthropic-ai/claude-agent-sdk", version: "0.3.283" } }) },
  { provider: "cursor", binary: () => null, install: [], versions: versions("1.0.31", { bundled: { package: "@cursor/sdk", version: "1.0.31", released: "2026-09-03T21:03:33.501Z", imports: "cursor-agent" } }), installations: [] },
]
const readings = {
  codex: { provider: "codex", binary: "/u/.nvm/bin/codex", installed: "0.159.3", channel: "npm", update: { label: "Update with npm", command: "npm", args: ["install", "-g", "@openai/codex@latest"] }, checkedAt: 1 },
  grok: { provider: "grok", binary: "/u/.grok/bin/grok", installed: "1.0.46", channel: "self", update: { label: "Update Grok", command: "/u/.grok/bin/grok", args: ["update"] }, checkedAt: 1 },
  devin: { provider: "devin", binary: "/u/Zed/external_agents/devin", installed: "3000.10.23", channel: "managed", managedBy: "Zed", checkedAt: 1 },
  opencode: { provider: "opencode", binary: "/opt/opencode", installed: "2.0.20", channel: "manual", checkedAt: 1 },
  claude: { provider: "claude", binary: "/u/.local/bin/claude", installed: "2.1.300", channel: "self", checkedAt: 1 },
  cursor: { provider: "cursor", binary: "/u/.local/bin/cursor-agent", installed: "2026.09.10-fd3934a", channel: "self", checkedAt: 1 },
} satisfies Record<string, HarnessUpdateInfo>
const root = await mkdtemp(join(tmpdir(), "mako-restore-versions-"))
try {
  const path = join(root, "runtime-updates.json")
  await writeFile(path, JSON.stringify({ version: 2, updates: readings, signatures: {} }))
  const updates = new RuntimeUpdates({ sources: () => sources, processes: new DiscoveryProcesses(), path, emit: () => {} })
  await updates.load()
  assert.deepEqual(updates.restoreRuntime("codex"), { harness: "codex", version: "0.159.3", sole: true, offer: { kind: "update", runtimeId: "codex", label: "Update with npm" } }, "npm: Mako runs the update")
  assert.deepEqual(updates.restoreRuntime("grok"), { harness: "grok", version: "1.0.46", sole: true, offer: { kind: "update", runtimeId: "grok", label: "Update Grok" } }, "the CLI's own updater: Mako runs it")
  assert.deepEqual(updates.restoreRuntime("devin"), { harness: "devin", version: "3000.10.23", sole: true, offer: { kind: "owner", owner: "Zed" } }, "another app's install: that app updates it")
  assert.deepEqual(updates.restoreRuntime("opencode"), { harness: "opencode", version: "2.0.20", sole: true, offer: { kind: "manual", command: "curl -fsSL https://opencode.ai/install | bash" } }, "an install Mako can't place: the command to run")
  assert.deepEqual(updates.restoreRuntime("claude"), { harness: "claude", version: "2.1.283", offer: { kind: "owner", owner: "Mako" }, lines: { claude: { version: "2.1.300", sole: true } } }, "Claude resumes under the Agent SDK's build, whatever CLI is installed beside it; Mako's update moves it")
  assert.deepEqual(updates.restoreRuntime("cursor"), { harness: "cursor", version: "1.0.31", offer: { kind: "owner", owner: "Mako" }, lines: { "cursor-agent": { version: "2026.09.03", reader: "Mako's @cursor/sdk 1.0.31, published 2026.09.03" } } }, "Cursor resumes under the SDK Mako ships, which imports cursor-agent's stores: they're compared with the day npm published it, whatever cursor-agent is installed")
  assert.deepEqual(updates.restoreRuntime("nothing"), { harness: "nothing", version: null, offer: { kind: "manual" } }, "a harness with no runtime blocks nothing")
  // Devin.app's own copy of the CLI: the app updates it, and the words name the app, not "Devin through Devin".
  const appPath = join(root, "runtime-updates-app.json")
  await writeFile(appPath, JSON.stringify({ version: 2, updates: { devin: { provider: "devin", binary: "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin", installed: "3000.10.23", channel: "app", managedBy: "Devin.app", checkedAt: 1 } }, signatures: {} }))
  const app = new RuntimeUpdates({ sources: () => sources, processes: new DiscoveryProcesses(), path: appPath, emit: () => {} })
  await app.load()
  const offer = app.restoreRuntime("devin").offer
  assert.deepEqual(offer, { kind: "owner", owner: "Devin" }, "Devin.app updates its own Devin")
  const back = returnNotice("Devin", { harness: "devin", installed: "3000.10.23", wrote: { version: "3000.11.205", source: "observed" }, offer })
  assert.equal(`${back.line} ${back.detail}`, "Devin 3000.11.205 wrote its latest turns in the cloud; this Mac has 3000.10.23. Update Devin through the Devin app, then bring it back. Until then it goes on in the cloud.")
} finally {
  await rm(root, { recursive: true, force: true })
}

// The gate, as both the restore and the plan ask it.
assert.equal(restoreGate({ record: ["2.1.300"], observed: [] }, "2.1.283").kind, "older")
assert.equal(restoreGate({ record: ["2.1.283"], observed: ["2.1.283"] }, "2.1.283").kind, "same-or-newer")
assert.equal(restoreGate({ record: [], observed: ["1.0.62"] }, "1.0.62").kind, "same-or-newer")
assert.equal(restoreGate({ record: ["0.154.0"], observed: [] }, "0.154.0-alpha.6.2").kind, "older", "a prerelease of the version that wrote it is older")
assert.deepEqual(outdatedOf(restoreGate({ record: [], observed: ["0.0.0-dev"] }, "3000.10.23")), { installed: "3000.10.23" }, "Devin's handshake's 0.0.0-dev names no build, so nothing shows 3000.10.23 reads what it wrote")

// A store another program wrote, which Mako's bundled build imports: compared in that program's numbering with the day the build was published.
const sdk = { version: "1.0.31", lines: { "cursor-agent": { version: "2026.09.03", reader: "Mako's @cursor/sdk 1.0.31, published 2026.09.03" } } }
const agentStore = (evidence: Partial<WriterEvidence>) => ({ record: [], observed: [], evidence: { source: "range" as const, line: "cursor-agent", why: "fixture", at: 1, ...evidence } })
assert.deepEqual(restoreGate(agentStore({ source: "install", versions: ["2026.10.14-0f9edde"] }), sdk), { kind: "older", wrote: { version: "2026.10.14-0f9edde", source: "install" }, installed: "2026.09.03", line: "cursor-agent", reader: "Mako's @cursor/sdk 1.0.31, published 2026.09.03" }, "a build made after the SDK was published may write what it doesn't read")
assert.equal(restoreGate(agentStore({ source: "install", versions: ["2026.09.02-aaaaaaa"] }), sdk).kind, "same-or-newer", "a build from before it was published")
assert.equal(restoreGate(agentStore({ upTo: "2026.09.03", bound: "build-day" }), sdk).kind, "same-or-newer", "a store last written by the day it was published")
assert.deepEqual(outdatedOf(restoreGate(agentStore({ upTo: "2026.10.15", bound: "build-day" }), sdk)), { installed: "2026.09.03", upTo: "2026.10.15", line: "cursor-agent", reader: "Mako's @cursor/sdk 1.0.31, published 2026.09.03" }, "one written since may be newer")
// Mako's own SDK agents, bounded by the SDK the repository pinned by their last write.
assert.equal(restoreGate({ record: [], observed: [], evidence: { source: "range", bound: "pins", upTo: "1.0.31", why: "fixture", at: 1 } }, sdk).kind, "same-or-newer")

// The pins table is the repository's history: every commit that changed the pinned SDK, with its time.
const git = new Git()
const repository = join(import.meta.dirname, "..")
const pinned = new Map<string, string>()
const commits = (await git.text({ cwd: repository, args: ["log", "--all", "--reverse", "--format=%H %cI", "-G\"@cursor/sdk\": \"", "--", "package.json", "packages/*/package.json"] })).split("\n").filter(Boolean)
for (const line of commits) {
  const [commit, at] = line.split(" ")
  const diff = await git.text({ cwd: repository, args: ["show", "--format=", commit!, "--", "package.json", "packages/*/package.json"] })
  for (const match of diff.matchAll(/^\+\s*"@cursor\/sdk": "([^"]+)"/gm)) if (!pinned.has(match[1]!)) pinned.set(match[1]!, at!)
}
git.close()
assert.ok(pinned.size > 0, "the history pins the SDK")
for (const [version, at] of pinned) assert.ok(MAKO_PINS.some((pin) => pin.package === "@cursor/sdk" && pin.version === version && Date.parse(pin.since) === Date.parse(at)), `MAKO_PINS names @cursor/sdk ${version}, pinned ${at}`)
for (const pin of MAKO_PINS) assert.equal(pinned.get(pin.version) && Date.parse(pinned.get(pin.version)!), Date.parse(pin.since), `${pin.package} ${pin.version} was first pinned when MAKO_PINS says`)
assert.equal(pinnedBy("@cursor/sdk", Date.parse("2026-09-13T22:00:00-07:00")), null, "no pin before the first")
assert.equal(pinnedBy("@cursor/sdk", Date.parse("2026-10-17T00:00:00Z"))?.version, "1.0.31")

// The window's words.
const outdated = { harness: "codex", wrote: { version: "0.163.0", source: "record" as const }, installed: "0.159.3", offer: { kind: "update" as const, runtimeId: "codex", label: "Update with npm" } }
assert.equal(outdatedLine("Codex", outdated), "Codex 0.163.0 wrote this session; this Mac has 0.159.3.")
assert.equal(outdatedLine("Grok", { ...outdated, wrote: { version: "1.0.62", source: "observed" } }), "Grok 1.0.62 ran this session; this Mac has 0.159.3.", "a version only observed ran it")
assert.equal(restoreNotice("Codex", outdated).detail, "Update Codex to resume it here, or reply now to go on from its transcript.")
assert.equal(restoreNotice("Claude Code", { ...outdated, offer: { kind: "owner", owner: "Mako" } }).detail, "A newer Mako brings Claude Code 0.163.0. Update Mako to resume it here, or reply now to go on from its transcript.")
assert.equal(restoreNotice("Devin", { ...outdated, offer: { kind: "owner", owner: "Zed" } }).detail, "Update Devin through Zed to resume it here, or reply now to go on from its transcript.")
assert.equal(restoreNotice("OpenCode", { ...outdated, offer: { kind: "manual", command: "npm i -g opencode-ai" } }).detail, "Update OpenCode from a terminal to resume it here, or reply now to go on from its transcript.")
assert.equal(carriedBecause("Codex", outdated), "Codex 0.159.3 here is older than 0.163.0")
// A store whose schema has no place for the rows' columns: an older build made it, so an update settles it.
const lacking = { harness: "devin", installed: "3000.10.23", lacks: ["tool_call_state.source_node_ids"], offer: { kind: "owner" as const, owner: "Devin" } }
assert.equal(outdatedLine("Devin", lacking), "A newer Devin wrote this session; this Mac has 3000.10.23.")
assert.equal(restoreNotice("Devin", lacking).detail, "Update Devin through the Devin app to resume it here, or reply now to go on from its transcript.")
assert.equal(updateResolves(lacking), true)
assert.equal(carriedBecause("Devin", lacking), "Devin 3000.10.23 here is older than the one that wrote it")
assert.equal(returnNotice("Devin", lacking).line, "A newer Devin wrote its latest turns in the cloud; this Mac has 3000.10.23.")
assert.equal(outdatedText("Devin", lacking), "Devin's store here has no tool_call_state.source_node_ids, which this session's records hold: a newer Devin wrote it, and this Mac has Devin 3000.10.23.")
const imported = { harness: "cursor", installed: "2026.09.03", line: "cursor-agent", reader: "Mako's @cursor/sdk 1.0.31, published 2026.09.03", offer: { kind: "owner" as const, owner: "Mako" } }
assert.equal(outdatedLine("Cursor", { ...imported, wrote: { version: "2026.10.14-0f9edde", source: "install" } }), "cursor-agent 2026.10.14-0f9edde wrote this session; Mako's @cursor/sdk 1.0.31, published 2026.09.03, may not read it.")
assert.equal(outdatedLine("Cursor", { ...imported, upTo: "2026.10.15" }), "Mako can't tell which cursor-agent version wrote this session, only that it was 2026.10.15 or older; Mako's @cursor/sdk 1.0.31, published 2026.09.03, may not read it.")
assert.equal(restoreNotice("Cursor", { ...imported, upTo: "2026.10.15" }).detail, "It resumes here once Mako ships a build that reads cursor-agent 2026.10.15; a reply now goes on from its transcript.")
assert.equal(updateResolves({ ...imported, upTo: "2026.10.15" }), false, "updating cursor-agent doesn't change what Mako's SDK reads")
assert.equal(carriedBecause("Cursor", { ...imported, upTo: "2026.10.15" }), "Mako's @cursor/sdk 1.0.31, published 2026.09.03, may not read what cursor-agent wrote")
assert.equal(outdatedText("Cursor", { ...imported, upTo: "2026.10.15" }), "Mako can't tell which cursor-agent version wrote this session; it may have been as new as 2026.10.15, and Mako's @cursor/sdk 1.0.31, published 2026.09.03, may not read it.")
for (const harness of registeredHarnessIds()) assert.match(restoreNotice(harness, { ...outdated, harness }).line, /^\S+ 0\.163\.0 wrote this session; this Mac has 0\.159\.3\.$/, `${harness}: one rule, one sentence`)

const row = { harness: "codex", version: "0.163.0", source: "record" as const, from: "saved" as const, kind: "response_item web_search_preview_call", reason: "unknown" as const, count: 14, sessions: 3, newestAt: 1, example: { kind: "none" as const } }
assert.deepEqual(unreadRowWords(row), { version: "0.163.0", versionDetail: "The harness's own records state this version.", counts: "new kind · 14 records in 3 sessions" })
assert.equal(unreadRowWords({ ...row, version: null, source: null }).version, "version unknown")
assert.equal(unreadRowWords({ ...row, from: "live", source: "reported", count: 1, reason: "unreadable" }).counts, "couldn't read · 1 live record")
assert.equal(unreadSummary({ rows: [], records: 0, sessions: 0, unattributed: 0 }), "Every record Mako has read so far decoded. When a harness release writes something new, it shows here by version until Mako reads it.")
assert.equal(unreadSummary({ rows: [row, { ...row, from: "live", count: 3 }], records: 14, sessions: 3, unattributed: 1 }), "Mako couldn't read 14 saved records in 3 sessions and 3 live records since Mako started, shown by the harness version that wrote them. 1 saved record isn't in Mako's record store yet, so its version isn't known.")
console.log("Restore versions: what each install resumes under and how it's updated, the gate, the cloud's choice, and the words")
