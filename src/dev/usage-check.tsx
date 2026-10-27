/* eslint-disable react-refresh/only-export-components -- This isolated acceptance entry is never imported by the application. */
// The usage surfaces as the production components draw them, from fixture
// stores: the composer meter's popover for each kind of harness reading, the
// line that offers another account at a plan limit, and Settings › Usage with
// reported cost, Mako's estimate, its own helper runs and the changes agents made. `?theme=dark` draws
// the dark theme, anything else the light one. No host, account or harness is touched.
import { createRoot } from "react-dom/client"
import { ContextMeter, UsageDetails } from "@/components/composer/context-meter"
import { ConversationScopeContext } from "@/state/conversation-scope"
import { useAccountLimitNotice } from "@/components/composer/account-notice"
import { ProducedNotice } from "@/components/composer/composer-notices"
import { UsageSection } from "@/components/settings/usage-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threadsStore } from "@/state/thread-store"
import { accountsStore } from "@/state/accounts"
import { acpStore, type LiveAcpConversation } from "@/state/acp"
import type { ContextBreakdown, LiveRequest, LiveSessionUsage } from "@/lib/types"
import type { ChangeUsage } from "@mako/host/contracts/thread-changes"
import type { ChangeCounts, TurnSpend } from "@mako/host/contracts/usage-ledger"
import { changeCounts } from "@/state/thread-changes"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import { fixtureUsageSummary } from "./usage-fixture"
import "../index.css"

// The app is dark unless `light` is on the root.
document.documentElement.classList.toggle("light", new URLSearchParams(location.search).get("theme") !== "dark")

installMockBridge()
const day = 86_400_000
const now = Date.now()
const summary = fixtureUsageSummary(now)
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
function Popover({ title, usage, harness, requests, sideQuestions, changes }: { title: string; usage: LiveSessionUsage; harness: string; requests: LiveRequest[]; sideQuestions?: number; changes?: ChangeCounts }) {
  return (
    <figure className="flex w-80 flex-col gap-2" data-fixture={harness}>
      <figcaption className="text-label text-faint">{title}</figcaption>
      <div className="rounded-lg bg-popover ring-1 ring-hairline shadow-md">
        <UsageDetails usage={usage} harness={harness} conversationId={`fixture-${harness}`} requests={requests} sideQuestions={sideQuestions} changes={changes} />
      </div>
    </figure>
  )
}

// The Thread's changes made: its turns' records summed, its own lines only, and two files that might be the person's apart.
const threadChanges = changeCounts({
  files: { created: 1, changed: 3, deleted: 0, renamed: 0 },
  lines: { added: 86, removed: 21 },
  commands: 4,
  outside: { named: 0, maybe: 0 },
  maybe: 2,
})

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
// A long Claude Code session, its meter at the window's foot: the popover must stop at the window's top and scroll inside.
const longClaude: LiveAcpConversation = {
  ...conversation, key: "fixture-claude-long", draftKey: "fixture-claude-long", harness: "claude",
  session: { ...conversation.session, id: "fixture-claude-long", harness: "claude", usage: { used: 171_000, size: 200_000, native: { tokens: tokens(91_000, 48_000_000, 1_400_000, 610_000), cost: 61.4 } } },
  requests: Array.from({ length: 60 }, (_, index) => turn({ provider: "claude", model: "claude-opus-5-5", at: now - (60 - index) * 300_000, tokens: tokens(800, 160_000, 4_000, 3_100, 900), cost: 0.42 }, index + 1)),
}
const longBreakdown: ContextBreakdown = {
  used: 171_000,
  size: 200_000,
  categories: [
    { name: "System prompt", tokens: 3_100, kind: "used" }, { name: "System tools", tokens: 14_600, kind: "used" },
    { name: "MCP tools", tokens: 21_800, kind: "used" }, { name: "Custom agents", tokens: 2_900, kind: "used" },
    { name: "Memory files", tokens: 9_400, kind: "used" }, { name: "Skills", tokens: 6_300, kind: "used" },
    { name: "Messages", tokens: 112_900, kind: "used" }, { name: "Free space", tokens: 0, kind: "free" },
    { name: "Autocompact buffer", tokens: 29_000, kind: "buffer" },
  ],
  items: [
    ...["linear", "github", "posthog", "notion", "sentry", "figma"].map((name, index) => ({ group: "mcp" as const, name, tokens: 6_000 - index * 700 })),
    ...["~/project/CLAUDE.md", "~/project/AGENTS.md", "~/.claude/CLAUDE.md", "~/project/docs/CLAUDE.md"].map((name, index) => ({ group: "memory" as const, name, tokens: 4_000 - index * 900 })),
    ...["reviewer", "explorer", "planner"].map((name, index) => ({ group: "agents" as const, name, tokens: 1_200 - index * 200 })),
    ...["frontend-design", "dataviz", "research", "unslop", "shadcn", "ux-copy"].map((name, index) => ({ group: "skills" as const, name, tokens: 1_400 - index * 150 })),
  ],
}
acpStore.set({ activeKey: conversation.key, conversations: { [conversation.key]: conversation, [longClaude.key]: longClaude } })
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
  liveContextBreakdown: async (id) => id === "fixture-cursor" ? cursorBreakdown : id === longClaude.key ? longBreakdown : bridge.liveContextBreakdown(id),
}

function Fixture() {
  return (
    <TooltipProvider>
      <main className="flex min-h-screen flex-col gap-8 bg-background p-8 text-foreground">
        <section className="flex flex-wrap items-start gap-6" data-fixture-meters>
          <Popover title="Claude Code: the fill, what each turn spent and its own count" harness="claude" requests={claudeTurns} sideQuestions={1} changes={threadChanges}
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
        <section className="fixed right-6 bottom-6 flex items-center gap-2 rounded-lg bg-surface py-1 pr-1 pl-3 ring-1 ring-hairline" data-fixture-bounded>
          <span className="text-label text-faint">A long Claude Code session&rsquo;s meter</span>
          <ConversationScopeContext.Provider value={{ kind: "live", key: longClaude.key }}>
            <ContextMeter />
          </ConversationScopeContext.Provider>
        </section>
      </main>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
