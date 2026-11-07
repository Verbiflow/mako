import assert from "node:assert/strict"
import { npmInstall, scriptInstall } from "@mako/host/harnesses/update-source"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { buildSources, unpublished } from "./lib/pinned-builds.ts"

// A pinned tested build its vendor withdrew is found where Mako installs it from, against a stub that answers as the
// vendor does: Devin's versioned setup script 403s for 3000.12.17, npm lists no such version. Each harness's own
// plans name the places asked.

const devinPlans = [scriptInstall("https://static.devin.ai/cli/3000.12.17/setup.sh")]
const grokPlans = [scriptInstall("https://x.ai/cli/install.sh", "1.0.77"), npmInstall("@xai-official/grok", "1.0.77")]
const codexPlans = [npmInstall("@openai/codex", "0.167.0"), { label: "Install with Homebrew", command: "brew", args: ["install", "codex"] }]

assert.deepEqual(buildSources(devinPlans, "3000.12.17"), [{ kind: "url", url: "https://static.devin.ai/cli/3000.12.17/setup.sh" }])
assert.deepEqual(buildSources(grokPlans, "1.0.77"), [{ kind: "npm", name: "@xai-official/grok" }], "an installer that takes the version as an argument answers for every version")
assert.deepEqual(buildSources(codexPlans, "0.167.0"), [{ kind: "npm", name: "@openai/codex" }])

/** A stub of the vendors: each URL's status, and npm's versions of each package. */
const vendor = (statuses: Record<string, number>, npm: Record<string, string[]> = {}): typeof fetch => async (input) => {
  // SAFETY: the check fetches by a URL string, as `unpublished` builds it.
  const url = String(input as string)
  const listed = Object.entries(npm).find(([name]) => url === `https://registry.npmjs.org/${name.replaceAll("/", "%2F")}`)
  if (listed) return Response.json({ versions: Object.fromEntries(listed[1].map((version) => [version, {}])) })
  if (url in statuses) return new Response("", { status: statuses[url] })
  throw new Error(`the stub has no ${url}`)
}

const setup = "https://static.devin.ai/cli/3000.12.17/setup.sh"
assert.equal(await unpublished(devinPlans, "3000.12.17", vendor({ [setup]: 403 })), `${setup} answers 403`)
assert.equal(await unpublished(devinPlans, "3000.12.17", vendor({ [setup]: 200 })), undefined, "a build still published is no news")
assert.equal(await unpublished(devinPlans, "3000.12.17", async () => { throw new TypeError("fetch failed") }), undefined, "an unreachable vendor says nothing of the build")
assert.equal(await unpublished(codexPlans, "0.167.0", vendor({}, { "@openai/codex": ["0.166.0"] })), "npm lists no @openai/codex@0.167.0")
assert.equal(await unpublished(codexPlans, "0.167.0", vendor({}, { "@openai/codex": ["0.166.0", "0.167.0"] })), undefined)
assert.equal(await unpublished(grokPlans, "1.0.77", vendor({}, { "@xai-official/grok": ["1.0.70"] })), "npm lists no @xai-official/grok@1.0.77")

// Every pinned harness's own plans name at least one place its tested build is asked at.
const host = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
for (const source of host.updateSources.list()) {
  if (!source.versions || source.versions.bundled) continue
  assert.ok(buildSources(source.install, source.versions.tested).length, `${source.provider}'s install plans name where ${source.versions.tested} is fetched`)
}
console.log("PASS: a pinned tested build is asked for where its harness installs it from: a versioned installer that 403s or npm listing no such version says it's withdrawn, and an unreachable vendor says nothing")
