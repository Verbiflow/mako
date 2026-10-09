import { parseArgs } from "node:util"
import { accessTierOfModeId, ACCESS_TIER_NAMES } from "../electron/contracts/access.ts"
import { providerHost } from "../electron/providers/index.ts"
import { LIVE_CAPABILITY_KEYS, LIVE_CAPABILITY_LABELS, type Capability } from "../electron/providers/live-capabilities.ts"
import { HARNESS_USAGE_KEYS, HARNESS_USAGE_LABELS } from "../electron/contracts/harness-usage.ts"
import { workDefaultProblems } from "../electron/contracts/harness-defaults.ts"
import { recordedCatalog } from "./model-catalogs.ts"

/**
 * What each installed harness declares about access, plans, approvals,
 * sign-in, usage and models, read from its `HarnessDefinition`, its profile
 * loader and its recorded model catalog without starting anything.
 *
 *   npm run audit:capabilities -- [--harness grok] [--detail]
 *
 * The table is the support matrix; the checks below it fail on declarations
 * that contradict each other, so a new or changed harness is held to the
 * same shape as the rest. Wire behaviour behind a declaration is proven by
 * the live probes (`test:grok-modes-live`) and the decoder fixtures.
 */

const options = parseArgs({ options: { harness: { type: "string" }, detail: { type: "boolean", default: false } } }).values

interface Row {
  harness: string
  ladder: string
  default: string
  plan: string
  approvals: string
  signIn: string
  accounts: string
}

const rows: Row[] = []
const problems: string[] = []
const details: string[] = []

for (const harness of providerHost.harnesses.list()) {
  const { provider, absent } = harness
  if (options.harness && provider !== options.harness) continue
  const live = providerHost.liveDrivers.get(provider)
  const acp = providerHost.acpSources.get(provider)
  const connection = providerHost.connections.get(provider)
  const accounts = providerHost.accountCapabilities.get(provider)
  const modes = live?.modes ?? []
  const fail = (problem: string) => problems.push(`${provider}: ${problem}`)

  const tiers = modes.map((mode) => mode.access ?? accessTierOfModeId(mode.id))
  const planning = live?.planning
  rows.push({
    harness: provider,
    ladder: modes.map((mode, index) => `${tiers[index] ?? mode.id}${mode.enforcement === "launch" ? "ᴸ" : ""}`).join(" ") || "none",
    default: tiers[modes.findIndex((mode) => mode.id === live?.defaultMode)] ?? live?.defaultMode ?? "none",
    plan: !planning ? "none" : planning.via === "mode" ? `mode ${planning.mode}` : `setting ${planning.option}`,
    approvals: live?.approvalEvidence.kind ?? "none",
    signIn: connection ? `Mako: ${connection.label}` : absent.connection ? `native: ${absent.connection.reason}` : "?",
    accounts: accounts ? accounts.mode : absent.accounts ? `none: ${absent.accounts.reason}` : "?",
  })
  details.push(
    `${provider}`,
    ...modes.map((mode) => `  mode ${mode.id}: ${mode.access ?? accessTierOfModeId(mode.id) ?? "no tier"}, ${mode.enforcement ?? "no enforcement"}${mode.description ? ` — ${mode.description}` : ""}`),
    `  plan: ${planning?.proposal ?? "none"}`,
    `  approvals: ${JSON.stringify(live?.approvalEvidence)}`,
    ...(acp?.access ? [`  ACP access: ${JSON.stringify(acp.access)}`] : []),
    ...(accounts ? [`  accounts: ${accounts.mode}, login \`${accounts.loginCommand ?? "none"}\``] : []),
  )

  // `validateLiveDriver` already refuses at install what a driver contradicts
  // in itself; these checks hold its declarations against the other families.
  if (!live) { fail("has no live driver"); continue }
  if (modes.length === 0) fail("declares no modes, so the desk can't show its access before launch")
  modes.forEach((mode, index) => {
    if (!tiers[index]) fail(`mode ${mode.id} names no access tier`)
    else if (!ACCESS_TIER_NAMES.includes(tiers[index])) fail(`mode ${mode.id} names an unknown tier`)
  })
  const repeated = tiers.filter((tier, index) => tier && tiers.indexOf(tier) !== index)
  if (repeated.length) fail(`offers ${repeated.join(", ")} twice`)
  if (!live.defaultMode && modes.length) fail("has no default mode, so a fresh session's access is unaccounted for")
  if (acp && planning?.via === "mode" && !acp.plans) fail("plans through a mode, but its ACP source decodes no plan cards")
  if (!connection && !absent.connection) fail("doesn't say how it signs in")
  if (!accounts && !absent.accounts) fail("doesn't say how its accounts are read")
  if (accounts && !accounts.loginCommand && !connection) fail("names no way to sign in: no login command and no Mako sign-in")
  if (acp?.access) {
    const { launch = [], native = {}, default: start } = acp.access
    for (const tier of launch) if (!tiers.includes(tier)) fail(`launches at ${tier}, which its ladder doesn't offer`)
    if (start && !launch.includes(start) && !(start in native)) fail(`ACP default ${start} is neither a launch tier nor a native mode`)
  }
}

const columns: (keyof Row)[] = ["harness", "ladder", "default", "plan", "approvals", "signIn", "accounts"]
const width = (column: keyof Row) => Math.min(48, Math.max(column.length, ...rows.map((row) => row[column].length)))
const cell = (text: string, column: keyof Row) => (text.length > width(column) ? `${text.slice(0, width(column) - 1)}…` : text).padEnd(width(column))
console.log(columns.map((column) => cell(column, column)).join("  "))
for (const row of rows) console.log(columns.map((column) => cell(row[column], column)).join("  "))
console.log("ᴸ: the harness reads the tier when its process starts; a running session keeps it.")

// Where each harness stands on each live capability, one column per harness.
const records = providerHost.harnesses.list().filter(({ provider }) => !options.harness || provider === options.harness)
const MARK = { implemented: "✓", "no-op": "no-op", default: "default", absent: "" } as const
const mark = (capability: Capability) => capability.state === "absent" ? (capability.by === "harness" ? "—" : "GAP") : MARK[capability.state]
const labelWidth = Math.max(...LIVE_CAPABILITY_KEYS.map((key) => LIVE_CAPABILITY_LABELS[key].length))
const columnWidth = Math.max(8, ...records.map(({ provider }) => provider.length))
console.log(`\n${"".padEnd(labelWidth)}  ${records.map(({ provider }) => provider.padEnd(columnWidth)).join("  ")}`)
for (const key of LIVE_CAPABILITY_KEYS)
  console.log(`${LIVE_CAPABILITY_LABELS[key].padEnd(labelWidth)}  ${records.map(({ capabilities }) => mark(capabilities[key]).padEnd(columnWidth)).join("  ")}`)
console.log("✓ Mako drives it · no-op: accepted, nothing to do · default: the harness's own behaviour · —: the harness has none · GAP: the harness has it, Mako doesn't drive it")
const gaps = records.flatMap(({ provider, capabilities }) => LIVE_CAPABILITY_KEYS.filter((key) => {
  const capability = capabilities[key]
  return capability.state === "absent" && capability.by === "mako"
}).map((key) => `${provider} ${LIVE_CAPABILITY_LABELS[key]}`))
if (gaps.length) console.log(`Gaps: ${gaps.join(", ")}`)
for (const { provider, capabilities } of records)
  details.push(`${provider} capabilities`, ...LIVE_CAPABILITY_KEYS.map((key) => {
    const capability = capabilities[key]
    return `  ${LIVE_CAPABILITY_LABELS[key]}: ${capability.state}${capability.state === "absent" ? ` (${capability.by})` : ""} — ${capability.state === "implemented" ? capability.via : capability.reason}`
  }))

// What each harness reports about usage: one row per harness, one column per reading.
const usageWidth = (key: (typeof HARNESS_USAGE_KEYS)[number]) => Math.max(HARNESS_USAGE_LABELS[key].length, 7)
console.log(`\n${"usage".padEnd(columnWidth)}  ${HARNESS_USAGE_KEYS.map((key) => HARNESS_USAGE_LABELS[key].padEnd(usageWidth(key))).join("  ")}`)
for (const { provider, usage } of records)
  console.log(`${provider.padEnd(columnWidth)}  ${HARNESS_USAGE_KEYS.map((key) => mark(usage[key]).padEnd(usageWidth(key))).join("  ")}`)
console.log("✓ reported · default: kept until the next reply · —: the harness reports none · GAP: reported, Mako doesn't read it")
for (const { provider, usage } of records)
  details.push(`${provider} usage`, ...HARNESS_USAGE_KEYS.map((key) => {
    const capability = usage[key]
    return `  ${HARNESS_USAGE_LABELS[key]}: ${capability.state}${capability.state === "absent" ? ` (${capability.by})` : ""} — ${capability.state === "implemented" ? capability.via : capability.reason}`
  }))

// Each harness's default model against the catalog it was last recorded with.
const modelRows = records.map(({ provider }) => {
  const defaults = providerHost.profiles.get(provider)?.defaults
  const catalog = recordedCatalog(provider)
  const [pick] = defaults?.work ?? []
  const fail = (problem: string) => problems.push(`${provider}: ${problem}`)
  if (!defaults) {
    fail("has no profile loader, so nothing lists its models")
    return [provider, "none", "none", "GAP"]
  }
  if (!pick) return [provider, "its own", "not recorded", defaults.none ?? "names no model and gives no reason"]
  if (!catalog) {
    fail(`has no recorded model catalog; run \`npm run harness:catalogs -- --harness ${provider}\``)
    return [provider, pick.model, "none", "GAP"]
  }
  const found = workDefaultProblems(defaults, catalog.models)
  for (const problem of found) fail(problem)
  const refused = catalog.models.filter((model) => model.unavailable).length
  const options = Object.entries(pick.options ?? {}).map(([id, value]) => `${id} ${String(value)}`).join(", ")
  return [
    provider,
    options ? `${pick.model} (${options})` : pick.model,
    `${catalog.models.length} models${refused ? `, ${refused} refused` : ""} · ${catalog.version ?? "no version"} · ${catalog.recorded}`,
    found.length ? found.join("; ") : "✓ offered",
  ]
})
const modelHeads = ["models", "default", "recorded catalog", "default in catalog"]
const modelWidths = modelHeads.map((head, index) => Math.max(head.length, ...modelRows.map((row) => row[index]!.length)))
console.log(`\n${modelHeads.map((head, index) => head.padEnd(modelWidths[index]!)).join("  ")}`)
for (const row of modelRows) console.log(row.map((cell, index) => cell.padEnd(modelWidths[index]!)).join("  ").trimEnd())

if (options.detail) console.log(`\n${details.join("\n")}`)
if (problems.length) {
  console.log(`\n${problems.length} contradiction${problems.length === 1 ? "" : "s"}:`)
  for (const problem of problems) console.log(`  ${problem}`)
  process.exitCode = 1
} else console.log("\nPASS: every harness declares a consistent ladder, plan mode, approvals and sign-in, and its default model is in its recorded catalog")
