import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { allowLiveProviderTest } from "./fixtures/live-provider-test.ts"
import { openCodeFreeModels } from "./opencode-free-models.ts"

for (const value of [undefined, "", "0", "true"])
  assert.throws(() => allowLiveProviderTest({ MAKO_ALLOW_LIVE_PROVIDER_TESTS: value }), /scripted fixture/)
assert.doesNotThrow(() => allowLiveProviderTest({ MAKO_ALLOW_LIVE_PROVIDER_TESTS: "1" }))
// Invalid executable/cwd and even preselected models must be refused before discovery, startup or a prompt.
await assert.rejects(openCodeFreeModels("/not-a-test-executable", {
  MAKO_OPENCODE_MODEL: "synthetic/one", MAKO_OPENCODE_SECOND_MODEL: "synthetic/two",
}, "/not-a-test-root"), /scripted fixture/)
for (const script of ["test-opencode-live.ts", "test-opencode-relocate-live.ts", "test-opencode-prompt-identity.ts"]) {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_BIN_PATH: "/not-a-test-executable" }
  delete env.MAKO_ALLOW_LIVE_PROVIDER_TESTS
  const child = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}`], { env, encoding: "utf8", timeout: 10_000 })
  assert.equal(child.status, 1, `${script} refuses by default`)
  assert.match(child.stderr, /Use a scripted fixture/)
}
console.log("PASS: live model tests refuse provider access by default")
