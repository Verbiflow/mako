import { homedir } from "node:os"
import { z } from "zod"
import type { JsonObject } from "../../codex-app-json.js"
import type { AcpVendorRequest } from "../acp-source.js"

/**
 * Grok's folder trust, from grok 1.0.46's source (`folder_trust_prompt.rs`).
 * A project's own config can run commands or steer the model, so Grok
 * ignores it in a folder the person hasn't trusted: MCP servers, hooks,
 * plugins, agents, language servers, permission rules, `.envrc`, workflows,
 * instructions and skills. Grok's terminal app asks at launch; a client
 * that sets `x.ai/folderTrust.interactive` in its `initialize` capabilities
 * is sent `_x.ai/folder_trust/request` once the session opens instead.
 * Grok goes on without the project's config meanwhile, and waits up to 30
 * minutes for `{ outcome: "trust" }`, which it saves to
 * `~/.grok/trusted_folders.toml` before reloading the session's MCP servers,
 * plugins and hooks. Instructions and skills apply from the next session.
 * Any other outcome leaves the folder untrusted, and Grok asks again in its
 * next process.
 */
export const GROK_FOLDER_TRUST_METHOD = "_x.ai/folder_trust/request"

/** The `initialize` capability that makes Grok ask instead of ignoring the project's config. */
export const GROK_FOLDER_TRUST_CAPABILITY = { "x.ai/folderTrust": { interactive: true } }

const FolderTrustRequestSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string(),
  /** The folder the grant covers: the repository's root, or the working folder outside one. */
  workspace: z.string().min(1),
  configKinds: z.array(z.string()).catch([]),
})

/** Grok's `configKinds`, in the order its scan finds them, as the person would name them. */
const KIND_NAMES = new Map([
  ["mcp", "MCP servers"],
  ["plugins", "plugins"],
  ["permission", "permission rules"],
  ["lsp", "language servers"],
  ["envrc", ".envrc"],
  ["claude", "Claude Code settings"],
  ["hooks", "hooks"],
  ["agents", "agents"],
  ["roles", "roles"],
  ["personas", "personas"],
  ["workflows", "workflows"],
  ["instructions", "instructions"],
  ["skills", "skills"],
])

const NEXT_SESSION = new Set(["instructions", "skills", "lsp"])

export function folderTrustRequest(params: JsonObject, home = homedir()): AcpVendorRequest | undefined {
  const parsed = FolderTrustRequestSchema.safeParse(params)
  if (!parsed.success) return undefined
  const { sessionId, configKinds } = parsed.data
  const workspace = parsed.data.workspace.startsWith(`${home}/`) ? `~${parsed.data.workspace.slice(home.length)}` : parsed.data.workspace
  const named = [...new Set(configKinds.map((kind) => KIND_NAMES.get(kind) ?? kind))]
  const skipped = named.length ? list(named) : "settings"
  const later = configKinds.some((kind) => NEXT_SESSION.has(kind))
  return {
    sessionId,
    updates: [],
    ask: {
      request: {
        title: "Trust this project in Grok?",
        detail: [
          `Grok ignores the ${skipped} in ${workspace} until you trust it.`,
          "A project's settings can run commands on this Mac, so trust only one you know.",
          later ? "Instructions, skills and language servers apply from the next conversation." : "",
        ].filter(Boolean).join(" "),
        options: [
          { optionId: "trust", name: "Trust project", kind: "allow_always" },
          { optionId: "reject", name: "Not now", kind: "reject_once" },
        ],
      },
      answers: [
        { optionId: "trust", result: { outcome: "trust" } },
        { optionId: "reject", result: { outcome: "reject" } },
      ],
      dismissed: { outcome: "reject" },
    },
  }
}

function list(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}
