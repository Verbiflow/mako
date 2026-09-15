import type {
  ChatMessage,
  GitStatus,
  IntegrationCatalogSnapshot,
  McpRegistrySnapshot,
  ModelInfo,
  SessionMeta,
  SessionSummary,
  SkillRegistrySnapshot,
  TreeNode,
} from "@/lib/types"

export const MODELS: ModelInfo[] = [
  m(
    "anthropic",
    "claude-opus-5",
    "Claude Opus 5",
    1_000_000,
    64_000,
    true,
    5,
    25,
    true
  ),
  m(
    "anthropic",
    "claude-sonnet-5",
    "Claude Sonnet 5",
    400_000,
    64_000,
    true,
    3,
    15,
    true
  ),
  m(
    "anthropic",
    "claude-haiku-4-5",
    "Claude Haiku 4.5",
    200_000,
    32_000,
    false,
    0.8,
    4,
    true
  ),
  m("openai", "gpt-5.2", "GPT-5.2", 400_000, 100_000, true, 1.25, 10, true),
  m("openai", "o5-mini", "o5-mini", 200_000, 65_000, true, 1.1, 4.4, false),
  m(
    "google",
    "gemini-3-pro",
    "Gemini 3 Pro",
    2_000_000,
    65_000,
    true,
    1.25,
    10,
    true
  ),
  m(
    "deepseek",
    "deepseek-v4",
    "DeepSeek V4",
    128_000,
    8_000,
    true,
    0.27,
    1.1,
    false
  ),
  m("zai", "glm-5", "GLM-5", 200_000, 32_000, true, 0.6, 2.2, false),
]

function m(
  provider: string,
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  deepThinking: boolean,
  input: number,
  output: number,
  vision: boolean
): ModelInfo {
  return {
    provider,
    id,
    name,
    reasoning: true,
    thinkingLevels: deepThinking
      ? ["off", "low", "medium", "high", "xhigh", "max"]
      : ["off", "low", "medium", "high"],
    contextWindow,
    maxTokens,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 },
  }
}

export const MESSAGES: ChatMessage[] = [
  {
    id: "m0",
    role: "user",
    timestamp: Date.now() - 900_000,
    blocks: [
      {
        type: "text",
        text: "The session rail re-renders on every streamed token. Find out why and fix it.",
      },
    ],
  },
  {
    id: "m1",
    role: "assistant",
    timestamp: Date.now() - 880_000,
    model: "claude-opus-5",
    blocks: [
      {
        type: "thinking",
        thinking:
          "A rail that repaints on every token almost always means one of two things: the list is subscribed to the whole session object, or the row components are not memoized and their props are recreated each render. Worth checking the store's read path first.",
      },
      {
        type: "text",
        text: "Let me look at how the rail reads from the store.",
      },
      {
        type: "toolCall",
        id: "t1",
        name: "grep",
        arguments: { pattern: "useSession", path: "src/components/rail" },
      },
      {
        type: "toolResult",
        id: "t1",
        name: "grep",
        text: "src/components/rail/session-rail.tsx:24:  const snapshot = useSession((state) => state)\nsrc/components/rail/session-rail.tsx:31:  const sessions = snapshot.sessions",
      },
      {
        type: "text",
        text: "There it is. The rail selects the **entire store object**, so any change — including the streaming message — invalidates it.\n\nThe fix is to select only the two slices the rail actually reads:",
      },
      {
        type: "toolCall",
        id: "t2",
        name: "edit",
        arguments: {
          file_path: "src/components/rail/session-rail.tsx",
          edits: [
            {
              oldText:
                "  const snapshot = useSession((state) => state)\n  const sessions = snapshot.sessions\n  const activePath = snapshot.meta?.sessionFile",
              newText:
                "  const sessions = useSession((state) => state.sessions)\n  const activePath = useSession((state) => state.meta?.sessionFile)",
            },
          ],
        },
      },
      {
        type: "toolResult",
        id: "t2",
        name: "edit",
        text: "Applied 1 edit to src/components/rail/session-rail.tsx",
      },
      {
        type: "toolCall",
        id: "t3",
        name: "bash",
        arguments: { command: "npx tsc --noEmit -p tsconfig.app.json" },
      },
      { type: "toolResult", id: "t3", name: "bash", text: "" },
      {
        type: "text",
        text: "Typecheck is clean. The rail now re-renders only when the session list or the active file changes — streaming tokens no longer touch it.\n\n```ts\nconst sessions = useSession((state) => state.sessions)\n```\n\nWorth checking the status bar for the same pattern; it reads five scalars and could collapse them into one shallow-compared selector.",
      },
    ],
  },
]

export const TREE: TreeNode[] = [
  {
    id: "m0",
    parentId: null,
    type: "message",
    preview: "The session rail re-renders on every streamed token…",
    role: "user",
    onPath: true,
    timestamp: new Date(Date.now() - 900_000).toISOString(),
    childIds: ["m1"],
  },
  {
    id: "m1",
    parentId: "m0",
    type: "message",
    preview: "There it is. The rail selects the entire store object…",
    role: "assistant",
    onPath: true,
    timestamp: new Date(Date.now() - 880_000).toISOString(),
    childIds: ["n2", "m2"],
  },
  {
    id: "n2",
    parentId: "m1",
    type: "message",
    preview: "Now do the same audit on the status bar",
    role: "user",
    onPath: false,
    timestamp: new Date(Date.now() - 600_000).toISOString(),
    childIds: [],
  },
  {
    id: "m2",
    parentId: "m1",
    type: "message",
    preview: "Actually, revert that and use a shallow comparator instead",
    role: "user",
    onPath: true,
    timestamp: new Date(Date.now() - 500_000).toISOString(),
    childIds: [],
  },
]

export const META: SessionMeta = {
  sessionId: "mock-session",
  sessionFile: "/tmp/sessions/rail-perf.jsonl",
  sessionName: "Rail re-render audit",
  cwd: "/Users/you/mako",
  leafId: "n3",
  model: MODELS[0],
  thinkingLevel: "high",
  thinkingLevels: MODELS[0].thinkingLevels,
  isStreaming: false,
  isIdle: true,
  isCompacting: false,
  isRetrying: false,
  isBashRunning: false,
  autoCompaction: true,
  queued: { steering: [], followUp: [] },
  cost: 0.4271,
  tokens: {
    input: 128_400,
    output: 9_120,
    cacheRead: 96_000,
    cacheWrite: 12_000,
    total: 245_520,
  },
  context: { tokens: 141_200, contextWindow: 1_000_000, percent: 14.1 },
  messageCount: MESSAGES.length,
}

export const GIT: GitStatus = {
  cwd: META.cwd,
  root: META.cwd,
  branch: "desk-refactor",
  ahead: 2,
  behind: 0,
  files: [
    {
      path: "src/components/rail/session-rail.tsx",
      status: "modified",
      insertions: 12,
      deletions: 9,
      binary: false,
      staged: false,
    },
    {
      path: "src/state/store.ts",
      status: "modified",
      insertions: 41,
      deletions: 3,
      binary: false,
      staged: true,
    },
    {
      path: "src/components/shell/status-bar.tsx",
      status: "added",
      insertions: 88,
      deletions: 0,
      binary: false,
      staged: false,
    },
    {
      path: "src/components/desk/chat-pane.tsx",
      status: "deleted",
      insertions: 0,
      deletions: 234,
      binary: false,
      staged: false,
    },
  ],
}

export const MCP: McpRegistrySnapshot = {
  cwd: META.cwd,
  generatedAt: Date.now(),
  providers: [
    {
      id: "claude",
      label: "Claude Code",
      account: "default",
      available: true,
      source: "~/.claude.json",
    },
    {
      id: "cursor",
      label: "Cursor",
      account: "default",
      available: true,
      source: "~/.cursor/mcp.json",
    },
    {
      id: "devin",
      label: "Devin",
      account: "default",
      available: false,
      source: "~/.config/devin/mcp_config.json",
    },
    {
      id: "codex",
      label: "Codex",
      account: "work",
      available: true,
      source: "codex mcp list --json",
    },
    {
      id: "grok",
      label: "Grok",
      account: "default",
      available: true,
      source: "grok mcp list --json",
    },
    {
      id: "opencode",
      label: "OpenCode",
      account: "default",
      available: true,
      source: "~/.opencode/config.json",
    },
  ],
  servers: [
    {
      id: "mock-axiom",
      name: "axiom",
      transport: "http",
      url: "https://mcp.axiom.co/mcp",
      envNames: [],
      headerNames: [],
      origins: [
        {
          provider: "codex",
          account: "work",
          scope: "effective",
          provenance: "codex mcp list --json",
        },
      ],
      portable: true,
    },
    {
      id: "mock-browser-use",
      name: "mako-browser-use",
      transport: "stdio",
      command: "/Applications/Mako.app/Contents/MacOS/Mako",
      args: ["browser-tools-main.js"],
      envNames: [],
      headerNames: [],
      origins: [
        {
          provider: "mako",
          account: "local",
          scope: "managed",
          provenance: "Mako managed",
        },
      ],
      portable: true,
      managed: true,
      availability: "available",
      detail:
        "Built-in browser tools share one approved local connection across tasks",
    },
    {
      id: "mock-local-control",
      name: "mako-local-control",
      transport: "stdio",
      command: "/Applications/Mako.app/Contents/MacOS/Mako",
      args: [
        "computer-tools-main.js",
        "--driver",
        "cua-driver",
        "--socket",
        "/tmp/mako-cua.sock",
      ],
      envNames: [],
      headerNames: [],
      origins: [
        {
          provider: "mako",
          account: "local",
          scope: "managed",
          provenance: "Mako managed",
        },
      ],
      portable: true,
      managed: true,
      availability: "available",
      detail: "Local browser and computer control run under Mako permissions",
    },
  ],
}

export const INTEGRATIONS: IntegrationCatalogSnapshot = {
  generatedAt: Date.now(),
  integrations: [
    {
      id: "linear",
      label: "Linear",
      description: "Find, create, and update issues and projects.",
      category: "Planning",
      trust: "official",
      auth: "provider-oauth",
      capabilities: ["Issues", "Projects", "Comments"],
      events: [],
      connection: {
        kind: "connected",
        detail: "claude",
        providers: ["claude"],
      },
      setupUrl: "https://linear.app/docs/mcp",
    },
    {
      id: "github",
      label: "GitHub",
      description:
        "Work with repositories, issues, pull requests, and actions.",
      category: "Development",
      trust: "official",
      auth: "provider-cli",
      capabilities: ["Repositories", "Issues", "Pull requests", "Actions"],
      events: [],
      connection: { kind: "ready", detail: "Signed in with GitHub CLI" },
    },
    {
      id: "mako-backend",
      label: "Mako Backend",
      description:
        "Remote MCP, skills, integrations, and communication channels.",
      category: "Development",
      trust: "mako",
      auth: "mako-backend",
      capabilities: ["MCP", "Skills", "Slack", "Durable agent"],
      events: [],
      connection: { kind: "ready", detail: "production · 0.1.0" },
    },
    {
      id: "slack",
      label: "Slack",
      description:
        "Read and send messages through your authenticated Mako backend.",
      category: "Communication",
      trust: "mako",
      auth: "mako-backend",
      capabilities: ["Channels", "Messages", "Threads", "Send"],
      events: [],
      connection: { kind: "ready", detail: "production · 0.1.0" },
    },
    {
      id: "notion",
      label: "Notion",
      description: "Read and update pages, databases, and comments.",
      category: "Productivity",
      trust: "official",
      auth: "provider-oauth",
      capabilities: ["Pages", "Databases", "Comments"],
      events: [],
      connection: {
        kind: "setup",
        detail: "Connect through an agent’s provider-owned sign-in",
      },
    },
    {
      id: "teams",
      label: "Microsoft Teams",
      description: "Read channels and work with team conversations.",
      category: "Communication",
      trust: "official",
      auth: "provider-oauth",
      capabilities: ["Channels", "Messages", "Members"],
      events: [],
      connection: {
        kind: "setup",
        detail: "Connect through an agent’s provider-owned sign-in",
      },
    },
    {
      id: "sentry",
      label: "Sentry",
      description: "Investigate issues, events, releases, and traces.",
      category: "Development",
      trust: "official",
      auth: "provider-oauth",
      capabilities: ["Issues", "Events", "Releases", "Traces"],
      events: [],
      connection: {
        kind: "setup",
        detail: "Connect through an agent’s provider-owned sign-in",
      },
    },
    {
      id: "google",
      label: "Google Workspace",
      description: "Use signed-in Google apps through a local browser session.",
      category: "Productivity",
      trust: "official",
      auth: "local-browser",
      capabilities: ["Gmail", "Calendar", "Drive", "Docs", "Sheets"],
      events: [],
      connection: { kind: "ready", detail: "Existing local Chrome via CDP" },
    },
    {
      id: "atlassian",
      label: "Atlassian",
      description: "Search and update Jira, Confluence, and Bitbucket.",
      category: "Planning",
      trust: "official",
      auth: "provider-oauth",
      capabilities: ["Jira", "Confluence", "Bitbucket"],
      events: [],
      connection: {
        kind: "setup",
        detail: "Connect through an agent’s provider-owned sign-in",
      },
    },
    {
      id: "local-browser",
      label: "Browser Use",
      description: "Control your existing local Chrome through CDP.",
      category: "Local",
      trust: "mako",
      auth: "local-permission",
      capabilities: ["Local Chrome", "Inspect", "Interact", "Capture"],
      events: [],
      connection: {
        kind: "ready",
        detail: "Existing local Chrome via CDP",
      },
    },
    {
      id: "computer-use",
      label: "Computer use",
      description: "Operate local applications without moving your pointer.",
      category: "Local",
      trust: "mako",
      auth: "local-permission",
      capabilities: ["Read UI", "Click", "Type", "Capture"],
      events: [],
      connection: {
        kind: "ready",
        detail: "Runs locally under Mako permissions",
      },
    },
  ],
}

export const SKILLS: SkillRegistrySnapshot = {
  cwd: META.cwd,
  generatedAt: Date.now(),
  providers: MCP.providers.map(({ id, label, account, available }) => ({
    id,
    label,
    account,
    available,
    readsUniversalRoot: false,
  })),
  skills: [
    {
      id: "mock-review",
      name: "code-review",
      description:
        "Review a change for correctness, regressions, and missing tests.",
      hash: "a".repeat(64),
      bytes: 2_480,
      files: 3,
      portable: true,
      origins: [
        {
          provider: "claude",
          account: "default",
          scope: "user",
          provenance: "/Users/you/.claude/skills/code-review/SKILL.md",
          hash: "a".repeat(64),
        },
        {
          provider: "agents",
          account: "local",
          scope: "workspace",
          provenance: `${META.cwd}/.agents/skills/code-review/SKILL.md`,
          hash: "a".repeat(64),
        },
      ],
    },
    {
      id: "mock-deploy-one",
      name: "deploy",
      description: "Deploy the current project after verification.",
      hash: "b".repeat(64),
      bytes: 1_280,
      files: 1,
      portable: true,
      conflict: "drift",
      origins: [
        {
          provider: "cursor",
          account: "default",
          scope: "user",
          provenance: "/Users/you/.cursor/skills/deploy/SKILL.md",
          hash: "b".repeat(64),
        },
        {
          provider: "codex",
          account: "work",
          scope: "user",
          provenance: "/Users/you/.codex/skills/deploy/SKILL.md",
          hash: "c".repeat(64),
        },
      ],
    },
    {
      id: "mock-wait-what",
      name: "wait-what",
      description: "Stop. That last message did not land: re-pitch it.",
      hash: "d".repeat(64),
      bytes: 640,
      files: 1,
      portable: true,
      manual: true,
      origins: [
        {
          provider: "agents",
          account: "local",
          scope: "user",
          provenance: "/Users/you/.agents/skills/wait-what/SKILL.md",
          hash: "d".repeat(64),
        },
      ],
    },
  ],
}

export function sessions(): SessionSummary[] {
  const now = Date.now()
  const make = (
    name: string,
    first: string,
    agoMinutes: number,
    count: number
  ): SessionSummary => ({
    path: `/tmp/sessions/${name.toLowerCase().replace(/\W+/g, "-")}.jsonl`,
    id: name,
    cwd: META.cwd,
    name,
    created: new Date(now - agoMinutes * 60_000).toISOString(),
    modified: new Date(now - agoMinutes * 60_000).toISOString(),
    messageCount: count,
    firstMessage: first,
  })
  return [
    make(
      "Rail re-render audit",
      "The session rail re-renders on every streamed token",
      4,
      12
    ),
    make(
      "Composer autogrow",
      "The textarea jumps a frame when it grows",
      55,
      8
    ),
    make(
      "Model picker keyboard nav",
      "Arrow keys should move through grouped results",
      190,
      21
    ),
    make(
      "Git status is slow",
      "Reading every file on each event is too expensive",
      1_500,
      34
    ),
    make("Theme tokens", "Pull the palette into one place", 4_400, 6),
    make(
      "Drop the bubbles",
      "Chat bubbles are wrong for a coding agent",
      12_000,
      17
    ),
  ]
}
