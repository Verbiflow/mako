import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { doctorReport, formatReport, type InstalledRuntime } from "./harness-doctor-report.ts"
import { loadFixtures } from "./native-decoding.ts"

/**
 * The doctor against a synthetic data directory: unknown records and host
 * log lines inside and outside the window, a rotated log, a capture, and a
 * Claude auth line carrying credentials that must never be printed.
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
  await mkdir(join(logs, "native-captures"), { recursive: true })
  const unknown = (at: string, harness: string, kind: string, reason = "unknown") =>
    JSON.stringify({ at, harness, kind, reason, record: { type: kind, authorization: BEARER } })
  await writeFile(join(logs, "native-unknown.jsonl"), [
    unknown(ago(30), "codex", "item/ancient"),
    unknown(ago(3), "codex", "item/frobnicated"),
    unknown(ago(2), "grok", "_x.ai/session/setup"),
    unknown(ago(1), "codex", "item/frobnicated"),
    unknown(ago(1), "codex", "thread/odd", "unreadable"),
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
    line(ago(1), "claude-auth", "Native authentication failure",
      `conversation=${CONVERSATION} category=access-revoked cause=refresh-expired accessToken=present refreshToken=present ` +
      `expiresAt=2026-10-03T10:00:00.000Z token=${TOKEN_VALUE} session=${OPAQUE} detail=${JSON.stringify(`upstream said ${BEARER}`)}`),
    line(ago(1), "live", "provider started", "harness=codex"),
  ].join("\n") + "\n")
  await writeFile(join(logs, "native-captures", "codex-c1-2026-10-03T10-00-00-000Z.jsonl"), "")

  const installed = async (harness: string): Promise<InstalledRuntime> =>
    harness === "codex" ? { version: "9.9.9", from: "/bin/codex", sdk: null }
      : harness === "cursor" ? { version: "1.0.31", from: "node_modules/@cursor/sdk", sdk: { name: "@cursor/sdk", version: "1.0.31" } }
        : { version: null, from: null, sdk: null, problem: "not installed" }
  const report = await doctorReport({ dataDir: root, days: 7, now, installed })
  const harness = (name: string) => {
    const found = report.harnesses.find((entry) => entry.harness === name)
    assert.ok(found, `reports ${name}`)
    return found
  }

  const codex = harness("codex")
  assert.deepEqual(codex.logs.unknown, [
    { kind: "item/frobnicated", reason: "unknown", count: 2, newest: ago(1) },
    { kind: "thread/odd", reason: "unreadable", count: 1, newest: ago(1) },
  ], "unknown records group by kind inside the window")
  assert.equal(codex.logs.hostLog?.notHandled, 2, "counts not-handled lines in the window, the rotated file included")
  assert.equal(codex.logs.hostLog?.unreadable, 1)
  assert.deepEqual(codex.logs.hostLog?.kinds.map((entry) => `${entry.kind} ${entry.reason} ${entry.count}`), ["item/frobnicated unknown 2", "thread/odd unreadable 1"])
  assert.equal(codex.logs.captures, 1)
  assert.equal(codex.logs.signIn, undefined, "only a harness that declares a sign-in scope reports one")
  assert.equal(codex.version.verdict, "newer-than-fixtures")
  assert.equal(codex.version.newestFixture, "0.159.0")
  assert.equal(codex.version.newestCaptured, null)
  assert.deepEqual([codex.decoder.fixtures, codex.decoder.captured, codex.decoder.written], [8, 0, 8])
  assert.deepEqual(codex.decoder.unexercised, [])
  assert.ok(codex.families.some((family) => family.family === "live" && family.status === "capability"))
  assert.ok(codex.families.some((family) => family.family === "acp" && family.status === "lacks" && family.reason))
  assert.equal(codex.live?.planning, "setting plan")

  const grok = harness("grok")
  assert.deepEqual(grok.logs.unknown?.map((group) => group.kind), ["_x.ai/session/setup"])
  assert.equal(grok.logs.hostLog?.notHandled, 2)
  assert.deepEqual(grok.logs.hostLog?.kinds.map((entry) => entry.kind), ["_x.ai/announcements/update", "_x.ai/session/setup"], "long event kinds are not mistaken for tokens")
  assert.deepEqual(grok.tools.other, [{ name: "frobnicate_widgets", expected: true }])
  assert.equal(grok.version.verdict, "unreadable")

  assert.equal(harness("cursor").version.verdict, "covered")
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
  assert.match(formatReport(report), /installed is newer than every fixture: the next capture becomes the new fixture/)

  const empty = await doctorReport({ dataDir: join(root, "missing"), days: 7, now, installed, harness: "claude" })
  assert.equal(empty.harnesses.length, 1)
  assert.deepEqual(empty.harnesses[0]?.logs, { unknown: null, hostLog: null, captures: 0, signIn: { scope: "claude-auth", count: 0, latest: null } })
  assert.match(formatReport(empty), /unknown {5}none recorded/)
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
