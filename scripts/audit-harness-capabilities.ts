import { parseArgs } from "node:util"
import { accessTierOfModeId, ACCESS_TIER_NAMES } from "../electron/contracts/access.ts"
import { providerHost } from "../electron/providers/index.ts"

/**
 * What each installed harness declares about access, plans, approvals and
 * sign-in, read from its `HarnessDefinition` without starting anything.
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
if (options.detail) console.log(`\n${details.join("\n")}`)
if (problems.length) {
  console.log(`\n${problems.length} contradiction${problems.length === 1 ? "" : "s"}:`)
  for (const problem of problems) console.log(`  ${problem}`)
  process.exitCode = 1
} else console.log("\nPASS: every harness declares a consistent ladder, plan mode, approvals and sign-in")
