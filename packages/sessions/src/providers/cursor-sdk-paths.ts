import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { z } from "zod"

/**
 * Where Mako keeps the Cursor SDK's local agent stores. The SDK's own default
 * hashes the workspace into `~/.cursor/projects/<slug>/sdk-agent-store`,
 * which spreads one user's agents over as many roots as they have projects
 * and hides them from a catalog scan; Mako passes one explicit root instead.
 * It is per user, beside the other `~/.mako` state, so the installed app and
 * a development host see the same agents — the same rule as the session
 * memory ledger. `MAKO_DATA_ROOT` is not a signal here: every launched host
 * receives it, the installed app's included, so branching on it would give
 * each host its own invisible set of agents. A fixture that must not touch the
 * user's agents sets `MAKO_CURSOR_SDK_ROOT` (or `HOME`) explicitly.
 */
export function cursorSdkStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (env.MAKO_CURSOR_SDK_ROOT) return env.MAKO_CURSOR_SDK_ROOT
  return join(home, ".mako", "cursor-sdk")
}

/** The SDK names an agent's directory by the SHA-256 of its id. */
export function cursorSdkAgentDirectory(stateRoot: string, agentId: string): string {
  return join(
    stateRoot,
    "agents",
    `agent-${createHash("sha256").update(agentId).digest("hex")}`
  )
}

/** One SQLite file per agent holds every turn of its conversation. */
export function cursorSdkStorePath(stateRoot: string, agentId: string): string {
  return join(cursorSdkAgentDirectory(stateRoot, agentId), "store.db")
}

/** The SDK's index of agents under a state root. */
export function cursorSdkIndexPath(stateRoot: string): string {
  return join(stateRoot, "index.db")
}

/**
 * Which Cursor process wrote a `store.db`. All three write the same blob
 * store format; what differs is who may reopen it. An `sdk` store is one of
 * Mako's own agents. `acp-sessions` (`cursor-agent acp`) and `chats`
 * (`cursor-agent -p`, the CLI's own sessions) are `cursor-agent`'s, and the
 * SDK continues them by importing the store under an agent of its own.
 */
export type CursorStoreOrigin =
  | { origin: "sdk"; directoryName: string }
  | { origin: "acp-sessions"; sessionId: string }
  | { origin: "chats"; sessionId: string; workspace: string }

export function cursorStoreOrigin(
  path: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {}
): CursorStoreOrigin | null {
  const home = options.home ?? homedir()
  const parts = (root: string): string[] | null =>
    path.startsWith(`${root}${sep}`) ? path.slice(root.length + 1).split(sep) : null
  const sdk = parts(join(cursorSdkStateRoot(options.env, home), "agents"))
  if (sdk) {
    const [directoryName, file] = sdk
    return sdk.length === 2 && file === "store.db" && directoryName?.startsWith("agent-")
      ? { origin: "sdk", directoryName }
      : null
  }
  const acp = parts(join(home, ".cursor", "acp-sessions"))
  if (acp) {
    const [sessionId, file] = acp
    return acp.length === 2 && file === "store.db" && sessionId && SESSION_ID.test(sessionId)
      ? { origin: "acp-sessions", sessionId }
      : null
  }
  const chats = parts(join(home, ".cursor", "chats"))
  if (chats) {
    const [workspace, sessionId, file] = chats
    return chats.length === 3 && file === "store.db" && workspace && sessionId && SESSION_ID.test(sessionId)
      ? { origin: "chats", sessionId, workspace }
      : null
  }
  return null
}

const SESSION_ID = /^[\w-]+$/

/**
 * The catalog identity of a `cursor-agent` store's row: the agent id, except
 * that a `chats/` store is its own row (`cursorChatIdentity`). An agent
 * imported from such a store records this so the two collapse. Without
 * `home` the other workspaces can't be looked at and a chats store reads as
 * the only one.
 */
export function cursorLegacyIdentity(origin: CursorStoreOrigin, nativeId: string, home?: string): string {
  if (origin.origin !== "chats") return nativeId
  if (home === undefined) return `chats:${nativeId}`
  const chats = join(home, ".cursor", "chats")
  return cursorChatIdentity(
    join(chats, origin.workspace, origin.sessionId, "store.db"),
    nativeId,
    cursorChatStores(chats, origin.sessionId)
  )
}

/** Every `chats/<workspace>/<session>/store.db` holding this session id. */
export function cursorChatStores(chatsRoot: string, sessionId: string): string[] {
  let workspaces: string[]
  try {
    workspaces = readdirSync(chatsRoot)
  } catch {
    return []
  }
  return workspaces
    .map((workspace) => join(chatsRoot, workspace, sessionId, "store.db"))
    .filter((store) => existsSync(store))
}

/**
 * The identity of a `chats/<workspace>/<session>/store.db` row. A `chats/`
 * copy of an ACP session is its own row (`chats:<id>`). `cursor-agent
 * --resume <id>` run from another folder starts a new conversation under
 * that folder's workspace, reusing the id and carrying none of the history
 * (verified 2026-09-28), so the stores are different conversations. The
 * earliest keeps `chats:<id>`, which is what every reference minted before
 * this names; each later one adds its workspace.
 */
export function cursorChatIdentity(store: string, nativeId: string, siblings: Iterable<string>): string {
  const others = [...new Set(siblings)].filter((other) => other !== store && existsSync(other))
  if (others.length === 0) return `chats:${nativeId}`
  const earliest = [store, ...others]
    .map((path) => ({ path, born: chatCreatedAt(path) }))
    .sort((a, b) => a.born - b.born || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0]
  return earliest?.path === store
    ? `chats:${nativeId}`
    : `chats:${basename(dirname(dirname(store)))}:${nativeId}`
}

const ChatMeta = z.object({ createdAtMs: z.number() })

/** When a chats store began; one without a readable meta.json sorts last. */
function chatCreatedAt(store: string): number {
  try {
    const meta = ChatMeta.safeParse(JSON.parse(readFileSync(join(dirname(store), "meta.json"), "utf8")))
    return meta.success ? meta.data.createdAtMs : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
