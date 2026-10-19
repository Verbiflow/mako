import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readReleaseTimelines, type NpmTimes } from "@mako/sessions/record-releases"
import { ReleaseTimelines } from "@mako/host/harnesses/release-timelines"
import type { ProviderUpdateSource } from "@mako/host/harnesses/update-source"

/**
 * The host's release dates for the record store's evidence pass: read only
 * for harnesses that declare where (`HarnessVersions.releases`), at most once
 * a day, kept in `records/evidence/releases.json`, and a failed read leaves
 * what was kept.
 */

const DAY = 24 * 60 * 60 * 1000
const root = await mkdtemp(join(tmpdir(), "mako-release-timelines-"))
try {
  const evidence = join(root, "evidence")
  const sources: ProviderUpdateSource[] = [
    { provider: "grok", binary: () => null, install: [], versions: { tested: "1.0.46", checked: { on: "2026-10-17", how: "fixture" }, feed: { npm: "@xai-official/grok" }, releases: { npm: "@xai-official/grok" } } },
    { provider: "codex", binary: () => null, install: [], versions: { tested: "0.159.3", checked: { on: "2026-10-17", how: "fixture" }, feed: { npm: "@openai/codex" } } },
  ]
  let now = Date.parse("2026-10-17T12:00:00Z")
  const asked: string[] = []
  let answer: NpmTimes | Error = { time: { created: "2025-10-22T05:02:25.858Z", "1.0.46": "2026-09-30T22:11:16.129Z", "1.0.62": "2026-10-16T16:53:47.482Z" } }
  const timelines = new ReleaseTimelines({
    evidence, sources: () => sources, now: () => now,
    packument: async (npmPackage) => {
      asked.push(npmPackage)
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  await timelines.refresh()
  assert.deepEqual(asked, ["@xai-official/grok"], "only a harness that declares where its release dates are")
  const kept = readReleaseTimelines(evidence)["npm:@xai-official/grok"]
  assert.deepEqual(kept?.releases.map((release) => release.version), ["1.0.46", "1.0.62"])
  assert.equal(kept?.checkedAt, now)
  now += DAY / 2
  await timelines.refresh()
  assert.equal(asked.length, 1, "read at most once a day")
  now += DAY
  answer = new Error("npm registry answered 503")
  await timelines.refresh()
  assert.equal(asked.length, 2, "a day on, read again")
  assert.equal(readReleaseTimelines(evidence)["npm:@xai-official/grok"]?.checkedAt, kept?.checkedAt, "a failed read leaves what was kept")
  await Promise.all([timelines.refresh(), timelines.refresh()])
  assert.equal(asked.length, 3, "callers at once share one read")
  console.log("Release timelines: read for declared harnesses at most daily, kept beside the evidence, a failure keeps the last")
} finally {
  await rm(root, { recursive: true, force: true })
}
