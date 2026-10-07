import { fixtureHarnesses } from "../src/dev/harness-fixtures"
import { threadsStore } from "../src/state/thread-store"
import assert from "node:assert/strict"
import type { HarnessProfile, ThreadRef } from "../src/lib/types"
import { ENVIRONMENT_SETUP_PROMPT } from "../electron/contracts/thread-environments"
import { appSetupContext, appSetupRow } from "../src/lib/app-setup-context"
import { firstRunAgent } from "../src/state/default-agent"
import { setupAgent } from "../src/state/project-setup"

/** Mako's order, as the host installs the harnesses. */
const MAKO_ORDER = fixtureHarnesses.map(({ provider }) => provider)

const profile = (
  id: string,
  available: boolean,
  pending = false
): HarnessProfile => ({
  id,
  label: id,
  available,
  pending,
  transport: "acp",
  defaultModel: `${id}-default`,
  settings: { model: `${id}-default` },
  models: [{ id: `${id}-default`, label: `${id} model`, options: [] }],
})
const profiles = (...list: HarnessProfile[]) =>
  Object.fromEntries(list.map((entry) => [entry.id, entry]))
const used = (harness: string, updatedAt: string): ThreadRef => ({
  path: `/history/${harness}/${updatedAt}`,
  harness,
  nativeId: `${harness}-${updatedAt}`,
  title: "",
  updatedAt,
})

threadsStore.set({ descriptors: fixtureHarnesses })

const all = profiles(
  profile("claude", true),
  profile("codex", true),
  profile("grok", true)
)

assert.equal(
  firstRunAgent(
    profiles(
      profile("devin", true),
      profile("grok", true),
      profile("opencode", true)
    ),
    []
  ),
  "opencode",
  "Mako's harness order, not the order profiles arrive in"
)
assert.equal(
  firstRunAgent(all, [], ["grok", "codex", "claude"]),
  "grok",
  "the person's harness order"
)
assert.equal(
  firstRunAgent(all, []),
  "claude",
  "no history: the first signed-in agent in the fixed order"
)
assert.equal(
  firstRunAgent(all, [
    used("claude", "2026-09-01T10:00:00Z"),
    used("codex", "2026-09-28T10:00:00Z"),
  ]),
  "codex",
  "the agent this Mac used most recently"
)
assert.equal(
  firstRunAgent(profiles(profile("claude", true), profile("codex", false)), [
    used("codex", "2026-09-28T10:00:00Z"),
  ]),
  "claude",
  "history with an agent that isn't signed in any more doesn't count"
)
assert.equal(
  firstRunAgent(profiles(profile("claude", false), profile("grok", true)), []),
  "grok",
  "the fixed order skips agents that aren't signed in"
)
assert.equal(
  firstRunAgent(profiles(profile("claude", false)), []),
  undefined,
  "nobody signed in"
)
assert.equal(
  firstRunAgent(
    profiles(profile("claude", false), profile("codex", false, true)),
    []
  ),
  "codex",
  "an agent still being asked about its models isn't skipped"
)

assert.deepEqual(
  setupAgent(all, {}, MAKO_ORDER),
  { harness: "claude", model: "claude model" },
  "a project is set up by the first signed-in harness in the order"
)
assert.deepEqual(
  setupAgent(all, {}, ["codex", "claude", "grok"]),
  { harness: "codex", model: "codex model" },
  "the person's order decides, whatever the composer has picked"
)
assert.deepEqual(
  setupAgent(profiles(profile("claude", false), profile("codex", true)), {}, MAKO_ORDER),
  { harness: "codex", model: "codex model" },
  "a harness that isn't signed in is passed over"
)
assert.deepEqual(
  setupAgent(
    profiles({ ...profile("claude", true), models: [...profile("claude", true).models, { id: "claude-big", label: "Claude big", options: [] }] }),
    { claude: { source: "saved", settings: { model: "claude-big" } } },
    MAKO_ORDER
  ),
  { harness: "claude", model: "Claude big" },
  "on the model saved for new conversations"
)
assert.equal(
  setupAgent(profiles(profile("claude", false)), {}, MAKO_ORDER),
  undefined,
  "nobody signed in, nobody sets it up"
)

const none = appSetupContext({ kind: "none", project: "shop", root: "/shop" })
assert.ok(
  none?.text.includes(ENVIRONMENT_SETUP_PROMPT) &&
    none.text.includes("recipe_guide"),
  "referencing an app with no recipe asks for the same setup, and names the guide"
)
assert.deepEqual(
  appSetupRow({ kind: "none", project: "shop", root: "/shop" }),
  { title: "Set up the app", hint: "shop · not set up" }
)
assert.match(
  appSetupContext({
    kind: "invalid",
    project: "shop",
    root: "/shop",
    message: "processes.web.port is outside the Thread's ports",
  })?.text ?? "",
  /recipe is broken: processes\.web\.port is outside/
)
const ready = appSetupContext({
  kind: "ready",
  project: "shop",
  phase: "stopped",
  processes: [{ name: "web", state: "stopped", port: 20140 }],
  checks: [{ tier: "quick", command: "npm test", state: "never" }],
})
assert.match(
  ready?.text ?? "",
  /Its processes: web on port 20140\. Its checks: quick check `npm test`\./,
  "a working recipe is summarised for a change"
)
assert.equal(
  appSetupContext({
    kind: "setting-up",
    project: "shop",
    root: "/shop",
    thread: { title: "Set up", harness: "codex", conversation: "c" },
  }),
  null,
  "nothing to attach while it's being set up"
)

console.log(
  "default agent: most recently used on this Mac, then the harness order, signed-in only; setup takes the first signed-in harness in the order"
)

