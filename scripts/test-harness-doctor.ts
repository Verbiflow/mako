import assert from "node:assert/strict"
import { UNREAD_INDEX_FILE, UnreadIndex } from "@mako/sessions/unread-index"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { doctorReport, formatReport, type InstalledRuntime } from "./harness-doctor-report.ts"
import { loadFixtures } from "./native-decoding.ts"

/**
 * The doctor against a synthetic data directory: unknown records, stream
 * and record differences, and host log lines inside and outside the window,
 * a rotated log, a capture, and a Claude auth line carrying credentials that
 * must never be printed.
 */

const now = new Date("2026-10-04T12:00:00.000Z")
const ago = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
const BEARER = "Bearer sk-ant-oat01-FAKEFAKEFAKE0123456789abcdef"
const TOKEN_VALUE = "supersecretvalue123"
const OPAQUE = "AbCdEfGhIjKlMnOpQrStUvWxYz0123"
const CONVERSATION = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b"

const root = await mkdtemp(join(tmpdir(), "mako-doctor-"))
try {
  const logs = join(root, "logs")
  await mkdir(logs, { recursive: true })
  const streams = join(root, "streams")
  await mkdir(join(streams, "codex"), { recursive: true })
  const unknown = (at: string, harness: string, kind: string, reason = "unknown", version?: string) =>
    JSON.stringify({ at, harness, ...version && { version }, kind, reason, record: { type: kind, authorization: BEARER } })
  await writeFile(join(logs, "native-unknown.jsonl"), [
    unknown(ago(30), "codex", "item/ancient"),
    unknown(ago(3), "codex", "item/frobnicated", "unknown", "0.163.0"),
    unknown(ago(2), "grok", "_x.ai/session/setup"),
    unknown(ago(1), "codex", "item/frobnicated", "unknown", "0.163.0"),
    unknown(ago(1), "codex", "thread/odd", "unreadable"),
    "not json",
  ].join("\n") + "\n")
  const mismatch = (at: string, harness: string, version: string, kind: string, type: string, conversation = CONVERSATION) => JSON.stringify({
    at, harness, version, conversation, kind, type,
    stream: { entries: [{ type, text: `said ${BEARER}` }], record: [], stream: [{ file: "mako-streams:codex/a.jsonl", ranges: [[0, 9]] }], originals: { record: [], stream: [{ kind: "range", file: "a", from: 0, to: 9, text: BEARER }] } },
    record: { entries: [], record: [], stream: [], originals: { record: [], stream: [] } },
  })
  const OTHER = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a"
  await writeFile(join(logs, "stream-mismatches.jsonl"), [
    mismatch(ago(30), "codex", "0.150.0", "stream-only", "text"),
    mismatch(ago(3), "codex", "0.159.3", "stream-only", "text"),
    mismatch(ago(2), "codex", "0.159.3", "changed", "provider-turn"),
    mismatch(ago(1), "codex", "0.159.3", "stream-only", "text", OTHER),
    "not json",
  ].join("\n") + "\n")
  const line = (at: string, scope: string, message: string, fields: string) => `${at} info  ${scope} ${message} ${fields}`
  await writeFile(join(logs, "host.log.1"), [
    line(ago(20), "live", "native event not handled", "harness=codex kind=item/ancient"),
    line(ago(4), "live", "native event not handled", "harness=codex kind=item/frobnicated kept=native-unknown.jsonl"),
  ].join("\n") + "\n")
  await writeFile(join(logs, "host.log"), [
    line(ago(10), "live", "native event not handled", "harness=codex kind=item/old"),
    line(ago(3), "live", "native event not handled", "harness=codex kind=item/frobnicated kept=native-unknown.jsonl"),
    line(ago(2), "claude-auth", "Native authentication failure", `conversation=${CONVERSATION} category=authentication_failed cause=unexplained`),
    line(ago(1), "live", "native event unreadable", "harness=codex kind=thread/odd"),
    line(ago(1), "live", "native event not handled", "harness=grok kind=_x.ai/session/setup"),
    line(ago(1), "live", "native event not handled", "harness=grok kind=_x.ai/announcements/update"),
    line(ago(1), "live", "native event not handled", "harness=grok kind=_x.ai/frobnicate/update"),
    line(ago(1), "claude-auth", "Native authentication failure",
      `conversation=${CONVERSATION} category=access-revoked cause=refresh-expired accessToken=present refreshToken=present ` +
      `expiresAt=2026-10-03T10:00:00.000Z token=${TOKEN_VALUE} session=${OPAQUE} detail=${JSON.stringify(`upstream said ${BEARER}`)}`),
    line(ago(1), "live", "provider started", "harness=codex"),
  ].join("\n") + "\n")
  await writeFile(join(streams, "codex", "thread-1@2026-10-03T10-00-00-000Z-c1.jsonl"), "")

  const installed = async (harness: string): Promise<InstalledRuntime> =>
    harness === "codex" ? { version: "9.9.9", from: "/bin/codex", sdk: null }
      : harness === "cursor" ? { version: "1.0.31", from: "node_modules/@cursor/sdk", sdk: { name: "@cursor/sdk", version: "1.0.31" } }
        : { version: null, from: null, sdk: null, problem: "not installed" }
  // Saved records the readers couldn't read, as the views noted them; no record store here, so no version is known.
  const views = join(root, "views")
  const index = new UnreadIndex(join(views, UNREAD_INDEX_FILE))
  index.note({ path: "/rollouts/a.jsonl", harness: "codex", nativeId: "a" }, "build", [
    { type: "unread", kind: "response_item future_item", reason: "unknown", id: "@10", at: Date.parse(ago(2)) },
    { type: "unread", kind: "response_item future_item", reason: "unknown", id: "@20", at: Date.parse(ago(1)) },
    { type: "unread", kind: "response_item image_generation_call", reason: "undrawn", id: "@30" },
  ])
  index.close()
  const report = await doctorReport({ dataDir: root, days: 7, now, installed, streams, views, records: join(root, "no-records") })
  const harness = (name: string) => {
    const found = report.harnesses.find((entry) => entry.harness === name)
    assert.ok(found, `reports ${name}`)
    return found
  }

  const codex = harness("codex")
  assert.deepEqual(codex.logs.unknown, [
    { version: "0.163.0", kind: "item/frobnicated", reason: "unknown", count: 2, newest: ago(1) },
    { version: "unknown", kind: "thread/odd", reason: "unreadable", count: 1, newest: ago(1) },
  ], "unknown records group by the version their launch reported and kind inside the window")
  assert.deepEqual(codex.unread?.groups.map((group) => [group.version, group.kind, group.count, group.newest.id]), [[null, "response_item future_item", 2, "@20"]], "saved records count by version, and a declared gap isn't one")
  assert.equal(codex.unread?.unattributed, 2)
  const codexText = formatReport({ ...report, harnesses: [codex] })
  assert.match(codexText, /unread {6}2 saved records in 1 session the readers couldn't read, by the version that wrote them \(2 not yet in the record store/)
  assert.match(codexText, /version unknown {2}response_item future_item {2}unknown ×2 in 1 session {2}newest @20 in \/rollouts\/a\.jsonl/)
  assert.match(codexText, /0\.163\.0 +item\/frobnicated {2}unknown ×2/)
  assert.equal(harness("grok").unread?.groups.length, 0)
  assert.deepEqual(codex.logs.mismatches, [
    { version: "0.159.3", kind: "stream-only", type: "text", count: 2, newest: ago(1), conversation: OTHER },
    { version: "0.159.3", kind: "changed", type: "provider-turn", count: 1, newest: ago(2), conversation: CONVERSATION },
  ], "differences between stream and record group by version, kind and type inside the window, naming the newest's conversation")
  assert.deepEqual(harness("grok").logs.mismatches, [], "a harness the file doesn't name has none")
  assert.match(formatReport({ ...report, harnesses: [codex] }), new RegExp(`stream-only text {2}0\\.159\\.3 {2}×2 {2}newest ${ago(1).replace(/\./g, "\\.")} in ${OTHER}`))
  assert.equal(codex.logs.hostLog?.notHandled, 2, "counts not-handled lines in the window, the rotated file included")
  assert.equal(codex.logs.hostLog?.unreadable, 1)
  assert.deepEqual(codex.logs.hostLog?.kinds.map((entry) => `${entry.kind} ${entry.reason} ${entry.count}`), ["item/frobnicated unknown 2", "thread/odd unreadable 1"])
  assert.equal(codex.logs.streams, 1)
  assert.equal(codex.logs.signIn, undefined, "only a harness that declares a sign-in scope reports one")
  assert.equal(codex.version.verdict, "newer-than-tested", "installed is compared with the declared tested version, not the fixtures")
  assert.equal(codex.version.declared?.tested, "0.159.3")
  assert.equal(codex.version.newestFixture, "0.159.3")
  assert.equal(codex.version.newestCaptured, null)
  assert.deepEqual([codex.decoder.fixtures, codex.decoder.captured, codex.decoder.written], [15, 0, 15])
  assert.deepEqual(codex.decoder.unexercised, [])
  assert.ok(codex.families.some((family) => family.family === "live" && family.status === "capability"))
  assert.ok(codex.families.some((family) => family.family === "acp" && family.status === "lacks" && family.reason))
  assert.equal(codex.live?.planning.state, "implemented", "the doctor reads the catalog the window shows")
  assert.equal(codex.live?.contextBreakdown.state, "absent")

  const grok = harness("grok")
  assert.deepEqual(grok.logs.unknown?.map((group) => [group.kind, group.handledBy]), [["_x.ai/session/setup", "grok/pager-notices"]],
    "a kind an older build logged and a fixture now decodes reads as handled")
  assert.equal(grok.logs.hostLog?.notHandled, 3)
  assert.deepEqual(grok.logs.hostLog?.kinds.map((entry) => [entry.kind, entry.handledBy]), [
    ["_x.ai/announcements/update", "grok/pager-settings"],
    ["_x.ai/frobnicate/update", undefined],
    ["_x.ai/session/setup", "grok/pager-notices"],
  ], "long event kinds are not mistaken for tokens")
  const grokText = formatReport({ ...report, harnesses: [grok] })
  assert.ok(grokText.indexOf("_x.ai/frobnicate/update") < grokText.indexOf("_x.ai/announcements/update"), "kinds still open are listed first")
  assert.ok(grokText.includes("_x.ai/session/setup ×1 (handled now: grok/pager-notices)"))
  assert.deepEqual(grok.tools.other, [{ name: "frobnicate_widgets", expected: true }])
  assert.equal(grok.version.verdict, "unreadable")

  assert.equal(harness("cursor").version.verdict, "tested", "Cursor's SDK is its runtime, at the declared tested version")
  assert.equal(harness("cursor").version.sdk?.newer, false)

  const claude = harness("claude")
  assert.equal(claude.logs.hostLog?.notHandled, 0)
  assert.equal(claude.logs.signIn?.count, 2)
  const latest = claude.logs.signIn?.latest
  assert.equal(latest?.at, ago(1))
  assert.equal(latest?.message, "Native authentication failure")
  assert.deepEqual(latest?.fields, {
    conversation: CONVERSATION,
    category: "access-revoked",
    cause: "refresh-expired",
    accessToken: "present",
    refreshToken: "present",
    expiresAt: "2026-10-03T10:00:00.000Z",
    token: "[redacted]",
    session: "…",
    detail: "upstream said Bearer …",
  })

  const printed = `${JSON.stringify(report)}\n${formatReport(report)}`
  for (const secret of ["FAKEFAKE", TOKEN_VALUE, OPAQUE]) assert.ok(!printed.includes(secret), `never prints ${secret}`)
  assert.match(formatReport(report), /installed is newer than tested 0\.159\.3: Mako runs it as it is/)
  assert.match(formatReport(report), /oldest 0\.146\.0 · tested 0\.159\.3/)
  const below = await doctorReport({ dataDir: root, days: 7, now, installed: async () => ({ version: "0.140.0", from: "/bin/codex", sdk: null }), harness: "codex", streams })
  assert.equal(below.harnesses[0]?.version.verdict, "below-oldest")
  assert.match(formatReport(below), /installed is below oldest 0\.146\.0: sessions refuse it/)

  const empty = await doctorReport({ dataDir: join(root, "missing"), days: 7, now, installed, harness: "claude", streams: join(root, "missing") })
  assert.equal(empty.harnesses.length, 1)
  assert.deepEqual(empty.harnesses[0]?.logs, { unknown: null, mismatches: null, hostLog: null, streams: 0, signIn: { scope: "claude-auth", count: 0, latest: null } })
  assert.match(formatReport(empty), /live {8}no unread live records \(no native-unknown\.jsonl\)/)
  assert.match(formatReport(empty), /merge {7}no differences recorded \(no stream-mismatches\.jsonl\)/)
  assert.match(formatReport(empty), /claude-auth none recorded/)

  const fixtures = join(root, "fixtures")
  await mkdir(join(fixtures, "codex"), { recursive: true })
  await writeFile(join(fixtures, "codex", "unversioned.json"), JSON.stringify({ harness: "codex", source: "codex-cli 0.159.0", about: "x", steps: [{ message: {} }] }))
  await writeFile(join(fixtures, "codex", "captured-without-version.json"), JSON.stringify({
    harness: "codex", source: "x", native: { version: null, sdk: { name: "x", version: "1.0.0" }, origin: "captured" }, about: "x", steps: [{ message: {} }],
  }))
  const loaded = await loadFixtures("codex", fixtures)
  assert.equal(loaded.files.length, 0)
  assert.deepEqual(loaded.invalid.map((file) => file.name), ["codex/captured-without-version", "codex/unversioned"])
  assert.match(loaded.invalid[1]?.problem ?? "", /native[\s\S]*every fixture says what it records/)
  assert.match(loaded.invalid[0]?.problem ?? "", /a captured fixture names the version it was captured from/)

  const old = new Date(ago(8))
  await utimes(join(logs, "host.log.1"), old, old)
  const rotated = await doctorReport({ dataDir: root, days: 7, now, installed, harness: "codex" })
  assert.equal(rotated.harnesses[0]?.logs.hostLog?.notHandled, 1, "a rotated log last written before the window is not read")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("PASS: harness doctor reports definitions, versions, coverage and recent native diagnostics without printing secrets")
