import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readableHarnesses } from "@mako/sessions"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import { LIVE_CAPABILITY_KEYS, LIVE_CAPABILITY_LABELS, type Capability, type LiveCapabilityKey } from "../electron/contracts/harness-capabilities.js"
import { HARNESS_FAMILIES, type HarnessFamily } from "../electron/providers/harness-definition.js"
import { harnessLabel } from "../electron/providers/harness-descriptors.js"
import { providerHost } from "../electron/providers/index.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { PAIRS_FOLDER } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"
import { NO_SOURCE, storedDefinitions } from "./native-tools.ts"

/**
 * Writes `docs/adding-a-harness.md`: what a new harness must implement, from
 * the code that requires it. The definition's families come from
 * `HARNESS_FAMILIES`, the live capabilities from the catalog, and what sits
 * beside the definition from `BESIDE_THE_DEFINITION` below, each step with
 * the test that enforces it and, where the repository shows it, a check of
 * every installed harness. `test-harness-definitions.ts` fails when the page
 * is stale or a harness misses a checked step. `--check` does the first.
 *
 *   npm run harness:checklist [-- --check]
 */

export const GENERATED_PATH = join(import.meta.dirname, "..", "docs", "adding-a-harness.md")

/** What each live capability asks of the driver, and the field that answers it. */
const CAPABILITY_ASKS = {
  resume: { field: "resume", asks: "Reopening a session in a new process: how, what the next message does after Mako closes the process, a checkpoint of the session's source, and who else holds it." },
  residency: { field: "resume", asks: "Follows resume: Mako closes an idle conversation's process only when its session can be reopened." },
  turnRecovery: { field: "turnRecovery", asks: "When a prompt counts as accepted and how a process death reaches the host, with the tests that kill the process mid-turn." },
  fork: { field: "fork", asks: "A fork that is the harness's own copy of the session, or one Mako imports through the session emitter." },
  steering: { field: "steering", asks: "A message sent into a running turn, and whether it lands at the next step or interrupts." },
  compaction: { field: "compaction", asks: "Compaction Mako starts, or the harness's own automatic compaction." },
  planning: { field: "planning", asks: "How the harness plans (a mode or a setting), how the plan reaches the plan card, and how a reply to it reaches the harness." },
  approvals: { field: "approvalEvidence", asks: "Whether the harness asks before acting, and whether it reports the decision it applied." },
  questions: { field: "questions", asks: "How the agent asks the person a question: a blocking request or a session question." },
  modes: { field: "modeSwitching", asks: "Switching the session's mode natively, with the modes it offers." },
  nativeAgents: { field: "nativeAgents", asks: "Observing the subagents the harness starts." },
  backgroundStop: { field: "backgroundStop", asks: "How Stop ends background work, or the evidence that none outlives its turn." },
  contextBreakdown: { field: "contextBreakdown", asks: "An itemized account of what fills the context window." },
} satisfies Record<LiveCapabilityKey, { field: keyof ProviderLiveDriver; asks: string }>

interface Step {
  title: string
  what: string
  enforcedBy: string
  /** Where one harness stands: done, a reason it declares instead, or what is missing. Absent when only the enforcing test can tell. */
  check?(harness: string): { done: true; reason?: string } | { done: false; missing: string }
}

const done = { done: true } as const
const missing = (what: string) => ({ done: false, missing: what }) as const
const jsonIn = (folder: string) => existsSync(folder) && readdirSync(folder).some((name) => name.endsWith(".json"))
const budgets = Object.keys(JSON.parse(readFileSync(join(import.meta.dirname, "performance-budgets.json"), "utf8")))

export const BESIDE_THE_DEFINITION: readonly Step[] = [
  {
    title: "Decoder fixtures",
    what: "Real sessions recorded into `scripts/fixtures/native-decoding/<harness>`, until coverage lists no declared kind.",
    enforcedBy: "`test-harness-definitions.ts`, `test:decoders`",
    check: (harness) => jsonIn(join(FIXTURE_ROOT, harness)) ? done : missing("no decoding fixtures"),
  },
  {
    title: "Saved history",
    what: "A `SessionProvider` in `@mako/sessions`, added to `SAVED_HISTORY_READERS` (`readers.ts`), which the catalog, the detached daemon and its sharing identity all read. If the store holds the live wire, it locates records and feeds the live decoder (`AcpSavedTurns` for ACP); otherwise it reads through the vocabulary module. A JSONL store gets a follower. A reader built outside the package goes to `defaultCatalog({ readers })`, as the stand-in's does.",
    enforcedBy: "`test-harness-definitions.ts`, `test-follow-convergence.ts`, the session flows' `import`",
    check: (harness) => readableHarnesses().includes(harness) ? done : missing("no saved-history reader"),
  },
  {
    title: "Decode pairs",
    what: "A recorder in `scripts/harness-decode-pairs.ts` (a scripted model, or the harness's own with the person's sign-in linked in), and every scenario recorded with `--write`. Each difference between live and saved that stays has its reason in `pair.json`.",
    enforcedBy: "`test-decode-pairs.ts`, `test-harness-usage.ts`",
    check: (harness) => existsSync(join(FIXTURE_ROOT, harness, PAIRS_FOLDER)) && readdirSync(join(FIXTURE_ROOT, harness, PAIRS_FOLDER)).length ? done : missing("no recorded pairs"),
  },
  {
    title: "Vocabulary",
    what: "A module in `packages/sessions/src/harnesses/`, added to `VOCABULARIES`: every tool with its kind, keys, aliases and MCP names, its usage field map, and its concepts (instructions, hooks, skills, commands, agents, MCP files, output, models, what only it has).",
    enforcedBy: "`test-harness-vocabulary.ts`, `test-tool-identity.ts`, `audit:tools -- --unresolved`",
    check: (harness) => VOCABULARIES.some((vocabulary) => vocabulary.harness === harness) ? done : missing("no vocabulary module"),
  },
  {
    title: "Concepts checked against the build",
    what: "An entry in `scripts/harness-self-report.ts`, then `npm run harness:self-report -- <harness>` and `npm run harness:concepts`.",
    enforcedBy: "`test-harness-concepts.ts`",
    check: (harness) => existsSync(join(import.meta.dirname, "fixtures", "native-vocabulary", `${harness}-concepts.json`)) ? done : missing("no concepts fixture"),
  },
  {
    title: "Native tool definitions",
    what: "`npm run harness:native-tools -- <harness>` records the tools the harness defines, per version, or `NO_SOURCE` in `scripts/native-tools.ts` says why they can't be recorded.",
    enforcedBy: "`test-native-tools.ts`",
    check: (harness) => storedDefinitions(harness).length ? done
      : NO_SOURCE.has(harness) ? { done: true, reason: `not recorded: ${NO_SOURCE.get(harness)}` } : missing("no recorded tool definitions"),
  },
  {
    title: "Usage",
    what: "One field map in the vocabulary module, built on `inclusiveTokens` or `exclusiveTokens` as the harness counts cache, called by the live decoder, the history reader and the `usageHistory` scanner. The scanner reads the store where the harness's own variable moved it (`UsageScan.env`), and a record the harness marks incomplete says so.",
    enforcedBy: "`test-session-usage.ts`, `test-harness-usage.ts`, `audit:capabilities`",
  },
  {
    title: "Opening saved history",
    what: "A baseline for its reader opening its largest kept pair to the first page, from `npx tsx scripts/test-performance-budgets.ts`; `npm run harness:saved-open` times the largest sessions on the machine.",
    enforcedBy: "`test:performance`",
    check: (harness) => budgets.some((name) => name.startsWith(`${harness} opens `)) ? done : missing("no saved-history budget"),
  },
  {
    title: "Failure stand-in",
    what: "A stand-in in `scripts/fixtures/native-failure-agent.mjs` that speaks enough of its protocol for setup, so its driver is tested against a process that dies.",
    enforcedBy: "`test:execution-ownership` (`test-native-failures.mjs` fails for a harness without one)",
  },
  {
    title: "Session flows",
    what: "`npm run test:session-flows -- <harness>` passes every flow its declarations call for on the real CLI, and `--record` then `--continue` passes. `test:seventh-harness` runs the same flows against a scripted ACP agent.",
    enforcedBy: "`test:session-flows`, `test:seventh-harness`",
  },
  {
    title: "A real planning turn",
    what: "One planning turn on the real CLI with `npm run probe:plan-turn`, then a review of the fixtures it records.",
    enforcedBy: "review",
  },
  {
    title: "Cloud sign-in",
    what: "Where the sign-in lives on Linux, whether it rotates, which credential the cloud gets, how it is installed on a machine and who refreshes it. Not built; Wayfinder's secrets page has the plan.",
    enforcedBy: "not built: a run that resumes a laptop session on a fresh Linux machine and checks the laptop is still signed in",
  },
  {
    title: "Development desk",
    what: "Its modes and plan approval in `src/dev/mock-bridge.ts` (`MOCK_MODES`, `MOCK_PLAN_APPROVALS`), copied from the real wire, so `?mock` shows what the harness shows.",
    enforcedBy: "review",
  },
  {
    title: "Only this harness",
    what: "A capability only this harness has is a field the others declare absent with a reason, and its UI registers against the field.",
    enforcedBy: "`mako/no-harness-names`",
  },
]

const label = (harness: string) => harnessLabel(providerHost, harness)
const cell = (text: string) => text.replaceAll("|", "\\|")

function familyCell(harness: string, family: HarnessFamily): string {
  const absent = providerHost.harnesses.get(harness)?.absent[family]
  return !absent ? "yes" : absent.absent === "mako" ? "gap" : "none"
}

function capabilityCell(capability: Capability | undefined): string {
  if (!capability) return "?"
  if (capability.state === "absent") return capability.by === "mako" ? "Mako gap" : "harness has none"
  return capability.state === "default" ? "by default" : capability.state
}

function stepCell(step: Step, harness: string): string {
  const result = step.check?.(harness)
  if (!result) return "–"
  return result.done ? (result.reason ? "declared" : "yes") : `**missing**: ${result.missing}`
}

/** Every checked step a harness misses. */
export function missingSteps(harness: string): string[] {
  return BESIDE_THE_DEFINITION.flatMap((step) => {
    const result = step.check?.(harness)
    return result && !result.done ? [`${step.title}: ${result.missing}`] : []
  })
}

export function renderHarnessChecklist(): string {
  const harnesses = providerHost.harnesses.list().map(({ provider }) => provider)
  const header = (first: string[]) => [`| ${[...first, ...harnesses.map(label)].join(" | ")} |`, `|${[...first, ...harnesses].map(() => " --- |").join("")}`]
  // SAFETY: HARNESS_FAMILIES satisfies a record over exactly the HarnessFamily keys.
  const families = Object.keys(HARNESS_FAMILIES) as HarnessFamily[]
  return [
    "<!-- Generated by `npm run harness:checklist` from the harness definition, the capability catalog and scripts/harness-checklist.ts. Do not edit. -->",
    "",
    "# Adding a harness",
    "",
    "What a new harness must implement, read from the code that requires it. Each step names the test that enforces it, and the tables show where the installed harnesses stand. `scripts/test-harness-definitions.ts` fails when this page is behind the code or an installed harness misses a step that has a check (a dash means only the enforcing test can tell).",
    "",
    "## 1. The definition",
    "",
    "Create `electron/providers/<harness>/index.ts` calling `installHarness(host, definition)` and add it to `electron/providers/index.ts`; its place there is Mako's order. Give `presentation.mark` (viewBox, paths, tint), `diagnostics` (the SDK Mako drives it through, whether sessions run inside it, its sign-in's log scope), and each family below: the capability, `lacks(reason)` when the harness has no such thing, or `notBuilt(reason)` when Mako hasn't built it (a gap). Then run `npm run harness:descriptors`. Enforced by the types, `installHarness`, `test-harness-definitions.ts`, and `test:seventh-harness`, which installs a seventh harness and runs the session flows against it.",
    "",
    ...header(["Family", "What it is"]),
    ...families.map((family) => `| \`${family}\` | ${cell(HARNESS_FAMILIES[family])} | ${harnesses.map((harness) => familyCell(harness, family)).join(" | ")} |`),
    "",
    "## 2. Live capabilities",
    "",
    "Each is a field of the live driver: implemented with what implements it, or absent as `unavailable` (the harness has none) or `not-built` (a Mako gap), with the reason the window shows. Enforced by the types and `validateLiveDriver`. `npm run harness:doctor -- <harness>` prints the reasons, and the session flows run each declared capability on the real CLI.",
    "",
    ...header(["Capability", "Driver field", "What it asks"]),
    ...LIVE_CAPABILITY_KEYS.map((key) => `| ${LIVE_CAPABILITY_LABELS[key]} | \`${CAPABILITY_ASKS[key].field}\` | ${cell(CAPABILITY_ASKS[key].asks)} | ${harnesses.map((harness) => capabilityCell(providerHost.harnesses.get(harness)?.capabilities[key])).join(" | ")} |`),
    "",
    "## 3. Beside the definition",
    "",
    ...header(["Step", "What to add", "Enforced by"]),
    ...BESIDE_THE_DEFINITION.map((step) => `| ${step.title} | ${cell(step.what)} | ${step.enforcedBy} | ${harnesses.map((harness) => stepCell(step, harness)).join(" | ")} |`),
    "",
    ...BESIDE_THE_DEFINITION.flatMap((step) => harnesses.flatMap((harness) => {
      const result = step.check?.(harness)
      return result?.done && result.reason ? [`- ${label(harness)}, ${step.title.toLowerCase()}: ${result.reason}`] : []
    })),
    "",
  ].join("\n")
}

if (import.meta.filename === process.argv[1]) {
  const rendered = renderHarnessChecklist()
  if (process.argv.includes("--check")) {
    if (!existsSync(GENERATED_PATH) || readFileSync(GENERATED_PATH, "utf8") !== rendered) {
      console.error("docs/adding-a-harness.md is behind the code. Run: npm run harness:checklist")
      process.exit(1)
    }
    console.log("Harness checklist: the page matches the code")
  } else {
    writeFileSync(GENERATED_PATH, rendered)
    console.log(`Wrote ${GENERATED_PATH}`)
  }
}
