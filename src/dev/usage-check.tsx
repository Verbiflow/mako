/* eslint-disable react-refresh/only-export-components -- This isolated acceptance entry is never imported by the application. */
// The usage surfaces as the production components draw them, from fixture
// stores: the composer meter's popover for each kind of harness reading, the
// line that offers another account at a plan limit, and Settings › Usage with
// reported cost, Mako's estimate, its own helper runs and the changes agents made. `?theme=dark` draws
// the dark theme, anything else the light one. No host, account or harness is touched.
import { createRoot } from "react-dom/client"
import { UsageDetails } from "@/components/composer/context-meter"
import { useAccountLimitNotice } from "@/components/composer/account-notice"
import { ProducedNotice } from "@/components/composer/composer-notices"
import { UsageSection } from "@/components/settings/usage-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threadsStore } from "@/state/thread-store"
import { accountsStore } from "@/state/accounts"
import { acpStore, type LiveAcpConversation } from "@/state/acp"
import type { ContextBreakdown, LiveRequest, LiveSessionUsage, UsageSummary } from "@/lib/types"
import type { TurnSpend } from "@mako/host/contracts/usage-ledger"
import type { ChangeUsage } from "@mako/host/contracts/thread-changes"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

// The app is dark unless `light` is on the root.
document.documentElement.classList.toggle("light", new URLSearchParams(location.search).get("theme") !== "dark")

installMockBridge()
const day = 86_400_000
const now = Date.now()
const totals = (cost: number, reported: number, input: number, output: number, cacheRead: number, cacheWrite: number, messages: number) =>
  ({ cost, reportedCost: reported, estimatedCost: cost - reported, input, output, cacheRead, cacheWrite, messages, pricedTokens: input + output + cacheRead + cacheWrite, unpricedTokens: 0 })
const summary: UsageSummary = {
  total: { ...totals(96.42, 31.18, 2_400_000, 410_000, 88_000_000, 1_900_000, 1_284), pricedTokens: 89_610_000, unpricedTokens: 3_100_000 },
  days: Array.from({ length: 30 }, (_, index) => ({ date: new Date(now - (29 - index) * day).toISOString().slice(0, 10), ...totals(index % 6 === 0 ? 1.2 : 2 + ((index * 7) % 5), 0.8, 80_000, 12_000, 2_900_000, 60_000, 40) })),
  models: [
    { model: "gpt-6.1-sol", ...totals(48.1, 0, 1_200_000, 200_000, 41_000_000, 0, 520) },
    { model: "claude-opus-5-5", ...totals(31.18, 31.18, 900_000, 160_000, 40_000_000, 1_800_000, 610) },
    { model: "anthropic/claude-haiku-4-5", ...totals(0.42, 0, 210_000, 9_000, 0, 0, 14) },
  ],
  projects: [{ cwd: "~/projects/billing", ...totals(70.3, 22.1, 1_700_000, 300_000, 60_000_000, 1_200_000, 900) }],
  sources: [
    { source: "Codex", harness: "codex", ...totals(48.1, 0, 1_200_000, 200_000, 41_000_000, 0, 520) },
    { source: "Claude Code", harness: "claude", ...totals(31.18, 31.18, 900_000, 160_000, 40_000_000, 1_800_000, 610) },
    { source: "Devin", harness: "devin", ...totals(0, 0, 90_000, 20_000, 3_000_000, 0, 140), unpricedTokens: 3_110_000, pricedTokens: 0 },
    { source: "Mako: Commit messages", ...totals(0.41, 0, 205_000, 8_800, 0, 0, 12) },
    { source: "Mako: Model connection checks", ...totals(0.01, 0, 5_000, 200, 0, 0, 2) },
  ],
  sessions: 12,
  truncated: false,
  priceTables: ["2026-10-06"],
}
const changes: ChangeUsage = {
  days: 14,
  total: { files: 1_284, added: 48_210, removed: 17_932, threads: 23 },
  projects: [
    { path: "/Users/fixture/projects/billing", files: 912, added: 39_120, removed: 14_002, threads: 19 },
    { path: "/Users/fixture/projects/billing-api", files: 301, added: 7_800, removed: 3_410, threads: 7 },
    { path: "/Users/fixture/notes", files: 71, added: 1_290, removed: 520, threads: 2 },
  ],
  certainty: { exact: 8_120, named: 1_410, window: 610, ambiguous: 233, person: 0, mako: 0 },
  moves: { moves: 17, came: 342, guessed: 41, putBack: 3, offered: 58, brought: 9 },
}

threadsStore.set({ descriptors: fixtureHarnesses })
const tokens = (input: number, cacheRead: number, cacheWrite: number, output: number, reasoning?: number) => ({ input, cacheRead, cacheWrite, output, ...reasoning !== undefined && { reasoning } })
const turn = (spend: TurnSpend, index: number): LiveRequest => ({ id: `turn-${index}`, text: "", attachments: [], status: "completed", spend })

/** The popover's body for one harness's reading, in a card the popover's width. */
function Popover({ title, usage, harness, requests, sideQuestions }: { title: string; usage: LiveSessionUsage; harness: string; requests: LiveRequest[]; sideQuestions?: number }) {
  return (
    <figure className="flex w-80 flex-col gap-2" data-fixture={harness}>
      <figcaption className="text-label text-faint">{title}</figcaption>
      <div className="rounded-lg bg-popover ring-1 ring-hairline shadow-md">
        <UsageDetails usage={usage} harness={harness} conversationId={`fixture-${harness}`} requests={requests} sideQuestions={sideQuestions} />
      </div>
    </figure>
  )
}

const claudeTurns = [
  turn({ provider: "claude", model: "claude-opus-5-5", at: now - 3_600_000, tokens: tokens(1_200, 1_310_000, 41_000, 18_400, 6_100), cost: 1.94 }, 1),
  turn({ provider: "claude", model: "claude-opus-5-5", at: now - 600_000, tokens: tokens(310, 402_000, 9_800, 6_200, 2_000), cost: 0.61 }, 2),
]
const codexTurns = [
  turn({ provider: "codex", model: "gpt-6.1-sol", at: now - 7_200_000, tokens: tokens(41_000, 880_000, 0, 12_400, 5_300), estimate: { amount: 0.39, currency: "USD", table: "2026-10-06" } }, 1),
  turn({ provider: "codex", model: "gpt-6.1-sol", at: now - 900_000, tokens: tokens(9_000, 310_000, 0, 4_100, 1_900), estimate: { amount: 0.1, currency: "USD", table: "2026-10-06" } }, 2),
]
const devinTurns = [turn({ provider: "devin", model: "swe-2", at: now - 1_800_000, tokens: tokens(3_700, 92_000, 0, 1_600) }, 1)]
const cursorTurns = [turn({ provider: "cursor", model: "claude-opus-5-5", at: now - 1_200_000, tokens: tokens(92, 10_500_000, 69_000, 29_000), estimate: { amount: 6.03, currency: "USD", table: "2026-10-06" } }, 1)]

// What a Cursor checkpoint itemized, from a stored agent's root (`token_details.breakdown`).
const cursorBreakdown: ContextBreakdown = {
  used: 85_400,
  size: 300_000,
  categories: ([
    ["System prompt", 2_899], ["Tool definitions", 5_439], ["Skills", 8_929], ["MCP & dynamic tools", 2_672],
    ["Subagent definitions", 1_747], ["Summarized conversation", 8_842], ["Conversation", 54_872],
  ] as const).map(([name, tokens]) => ({ name, tokens, kind: "used" as const })),
  items: [],
}

// The composer above the limit line runs on Codex, whose account is near its weekly limit.
const conversation: LiveAcpConversation = {
  kind: "live", key: "fixture-codex", draftKey: "fixture-codex", harness: "codex", cwd: "/fixture",
  session: { id: "fixture-codex", harness: "codex", cwd: "/fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  requests: codexTurns, permission: null, sending: false, canceling: false, blocks: [], queued: [], hiddenUserPrompt: null, createdAt: 0, updatedAt: 0,
}
acpStore.set({ activeKey: conversation.key, conversations: { [conversation.key]: conversation } })
const weekly = (usedPercent: number) => ({ usedPercent, windowMinutes: 7 * 24 * 60, resetsAt: now + 2 * day })
accountsStore.set({
  providers: [{ provider: "codex", label: "Codex", mode: "selectable", loginCommand: "codex login" }],
  accounts: [
    { harness: "codex", name: "default", email: "work@example.com", active: true },
    { harness: "codex", name: "personal", email: "personal@example.com", active: false, source: "mako" },
  ],
  loadedAt: now,
  usage: {
    "codex:default": { status: "ok", plan: "pro", windows: [{ usedPercent: 41, windowMinutes: 300, resetsAt: now + 7_200_000 }, weekly(96)], readAt: now },
    "codex:personal": { status: "ok", plan: "plus", windows: [{ usedPercent: 3, windowMinutes: 300, resetsAt: now + 9_000_000 }, weekly(12)], readAt: now },
  },
  limitOffers: { codex: { harness: "codex", because: "near-limit", from: { name: "default", email: "work@example.com", window: weekly(96) }, to: { name: "personal", email: "personal@example.com", window: weekly(12) } } },
})

// The mock bridge's own summary has no estimate or helper runs, and its accounts aren't these; this fixture's are.
const bridge = window.mako
if (bridge) window.mako = {
  ...bridge,
  usage: async () => summary,
  changeUsage: async () => changes,
  accounts: async () => ({ providers: accountsStore.get().providers, accounts: accountsStore.get().accounts.map((account) => ({ ...account, dir: "" })) }),
  accountUsage: async (harness, name) => accountsStore.get().usage[`${harness}:${name}`] ?? { status: "unavailable" },
  liveContextBreakdown: async (id) => id === "fixture-cursor" ? cursorBreakdown : bridge.liveContextBreakdown(id),
}

function Fixture() {
  return (
    <TooltipProvider>
      <main className="flex min-h-screen flex-col gap-8 bg-background p-8 text-foreground">
        <section className="flex flex-wrap items-start gap-6" data-fixture-meters>
          <Popover title="Claude Code: the fill, what each turn spent and its own count" harness="claude" requests={claudeTurns} sideQuestions={1}
            usage={{ used: 124_000, size: 200_000, native: { tokens: tokens(4_100, 3_900_000, 120_000, 61_000), cost: 5.82 } }} />
          <Popover title="Devin right after a compaction it didn't measure" harness="devin" requests={devinTurns}
            usage={{ compactedFrom: 15_856, size: 262_000 }} />
          <Popover title="Codex: Mako's estimate, marked, with its table" harness="codex" requests={codexTurns}
            usage={{ used: 61_000, size: 400_000 }} />
          <Popover title="Cursor: its checkpoint's reading, itemized, spend estimated" harness="cursor" requests={cursorTurns}
            usage={{ used: cursorBreakdown.used, size: cursorBreakdown.size }} />
        </section>
        <section className="flex w-[760px] flex-col gap-2" data-fixture-limit>
          <span className="text-label text-faint">Above the composer, when the account in use nears its plan limit</span>
          <ProducedNotice use={useAccountLimitNotice} />
        </section>
        <section className="w-[720px]" data-fixture-settings>
          <UsageSection />
        </section>
      </main>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
