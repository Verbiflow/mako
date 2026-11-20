import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repoAvatar } from "@mako/host/git/github"
import { AVATAR_HUES, avatarHue, monogram, titleTone } from "@/lib/rail-marks"
import { githubOwner } from "@/state/repo-avatars"
import { failedAutomationRuns } from "@/state/automations"

/**
 * The calm rail's rules that hold without a window: avatars' hues and letters, a row's title tone, the GitHub owner a
 * project's avatar is asked by (and the host's kept picture, asked of nobody), and failed automations in the Inbox.
 */

// Avatars: one hue a seed, the same every time, spread over all eight; a letter or digit of the name.
assert.equal(avatarHue("/Users/you/api"), avatarHue("/Users/you/api"))
const hues = new Set(Array.from({ length: 64 }, (_, index) => avatarHue(`/Users/you/project-${index}`)))
assert.equal(hues.size, AVATAR_HUES, "64 projects take every hue")
assert.deepEqual(["api", "@scope/x", "9lives", "", "élan"].map(monogram), ["A", "S", "9", "?", "É"])

// A title's tone: lit, then what needs the person or waits to be read, then Done faded, then quiet.
assert.equal(titleTone(true, { kind: "needs-permission", since: 0 }), "font-medium text-foreground")
assert.equal(titleTone(false, { kind: "needs-permission", since: 0 }), "text-foreground")
assert.equal(titleTone(false, { kind: "review", at: 1, unread: true }), "text-foreground")
assert.equal(titleTone(false, { kind: "idle" }), "text-foreground/72")

// Only a GitHub login leaves the Mac, and only the owner of `owner/name`.
assert.equal(githubOwner("acme/api"), "acme")
assert.equal(githubOwner("a-b/c"), "a-b")
for (const bad of [null, undefined, "", "-acme/x", "acme-/x", "ac--me/x", "../etc/x", "a".repeat(40) + "/x", "ac me/x"]) assert.equal(githubOwner(bad), undefined, String(bad))
const avatars = mkdtempSync(join(tmpdir(), "mako-rail-avatars-"))
try {
  mkdirSync(avatars, { recursive: true })
  writeFileSync(join(avatars, "acme.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.equal(await repoAvatar("acme/api", avatars), "data:image/png;base64,iVBORw==", "a kept picture is read from disk, asked of nobody")
  assert.equal(await repoAvatar("../../etc/passwd", avatars), undefined, "a name that isn't a login is never fetched")
  assert.equal(await repoAvatar("", avatars), undefined)
} finally {
  rmSync(avatars, { recursive: true, force: true })
}

// Failed automations count in the Inbox from when Automations was last opened.
const state = { projects: [{ automations: [{ lastRun: { status: "failed" as const, at: 50 } }, { lastRun: { status: "failed-to-start" as const, at: 150 } }, { lastRun: { status: "failed" as const, at: 20, endedAt: 250 } }, {}] }] }
assert.equal(failedAutomationRuns(state, 0), 3)
assert.equal(failedAutomationRuns(state, 100), 2, "what failed before Automations was opened is read")
assert.equal(failedAutomationRuns(state, 200), 1, "a run counts from when it ended")
assert.equal(failedAutomationRuns(state, 300), 0)
console.log("Calm rail checks clean: avatars, title tones, GitHub owners, failed automations")
