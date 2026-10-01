import assert from "node:assert/strict"
import type { HarnessProfile, ThreadRef } from "../src/lib/types"
import { ENVIRONMENT_SETUP_PROMPT } from "../electron/contracts/thread-environments"
import { appSetupContext, appSetupRow } from "../src/lib/app-setup-context"
import { firstRunAgent } from "../src/state/default-agent"
import { setupAgent } from "../src/state/project-setup"

const profile = (id: string, available: boolean, pending = false): HarnessProfile => ({
  id,
  label: id,
  available,
  pending,
  transport: "acp",
  capabilities: [],
  defaultModel: `${id}-default`,
  settings: { model: `${id}-default` },
  models: [{ id: `${id}-default`, label: `${id} model`, options: [] }],
})
const profiles = (...list: HarnessProfile[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]))
const used = (harness: string, updatedAt: string): ThreadRef => ({
  path: `/history/${harness}/${updatedAt}`,
  harness,
  title: "",
  updatedAt,
})

const all = profiles(profile("claude", true), profile("codex", true), profile("grok", true))

assert.equal(firstRunAgent(all, []), "claude", "no history: the first signed-in agent in the fixed order")
assert.equal(
  firstRunAgent(all, [used("claude", "2026-09-01T10:00:00Z"), used("codex", "2026-09-28T10:00:00Z")]),
  "codex",
  "the agent this Mac used most recently"
)
assert.equal(
  firstRunAgent(profiles(profile("claude", true), profile("codex", false)), [used("codex", "2026-09-28T10:00:00Z")]),
  "claude",
  "history with an agent that isn't signed in any more doesn't count"
)
assert.equal(
  firstRunAgent(profiles(profile("claude", false), profile("grok", true)), []),
  "grok",
  "the fixed order skips agents that aren't signed in"
)
assert.equal(firstRunAgent(profiles(profile("claude", false)), []), undefined, "nobody signed in")
assert.equal(
  firstRunAgent(profiles(profile("claude", false), profile("codex", false, true)), []),
  "codex",
  "an agent still being asked about its models isn't skipped"
)

assert.deepEqual(setupAgent(all, {}, "codex", []), { harness: "codex", model: "codex model" }, "a new setup Thread uses the agent last picked")
assert.deepEqual(
  setupAgent(all, {}, undefined, [used("grok", "2026-09-28T10:00:00Z")]),
  { harness: "grok", model: "grok model" },
  "before any pick, the first-run choice, and nothing is named as skipped"
)
assert.deepEqual(
  setupAgent(profiles(profile("claude", true), profile("codex", false)), {}, "codex", []),
  { harness: "claude", model: "claude model", standingInFor: "codex" },
  "a picked agent that isn't signed in is skipped for the first-run choice, and named"
)
assert.equal(setupAgent(all, {}, "gone", [])?.standingInFor, undefined, "an agent Mako no longer has is ignored, not reported")
assert.equal(setupAgent(profiles(profile("claude", false)), {}, "claude", []), undefined, "nobody signed in, nobody sets it up")

const none = appSetupContext({ kind: "none", project: "shop", root: "/shop" })
assert.ok(none?.text.includes(ENVIRONMENT_SETUP_PROMPT) && none.text.includes("recipe_guide"), "referencing an app with no recipe asks for the same setup, and names the guide")
assert.deepEqual(appSetupRow({ kind: "none", project: "shop", root: "/shop" }), { title: "Set up the app", hint: "shop · not set up" })
assert.match(appSetupContext({ kind: "invalid", project: "shop", root: "/shop", message: "processes.web.port is outside the Thread's ports" })?.text ?? "", /recipe is broken: processes\.web\.port is outside/)
const ready = appSetupContext({
  kind: "ready", project: "shop", phase: "stopped",
  processes: [{ name: "web", state: "stopped", port: 20140 }],
  checks: [{ tier: "quick", command: "npm test", state: "never" }],
})
assert.match(ready?.text ?? "", /Its processes: web on port 20140\. Its checks: quick check `npm test`\./, "a working recipe is summarised for a change")
assert.equal(appSetupContext({ kind: "setting-up", project: "shop", root: "/shop", thread: { title: "Set up", harness: "codex", conversation: "c" } }), null, "nothing to attach while it's being set up")

console.log("default agent: most recently used on this Mac, then the fixed order, signed-in only; a new setup Thread follows the agent last picked")
