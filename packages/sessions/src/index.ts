/**
 * @mako/sessions — one format for coding-agent sessions.
 *
 * Reads every supported harness's native session store, keeps a live catalog
 * of all of them, and renders any thread for continuation on any other
 * harness. Pure library: node builtins only, no Electron, no UI, so anything
 * — this desktop app, a CLI, a server — can hold the same catalog.
 */

export {
  titleFrom,
  threadIdentity,
  userTextFrom,
  clip,
  type EntryBlock,
  type Harness,
  type Thread,
  type ThreadEntry,
  type ThreadOrigin,
  type ThreadPage,
  type ThreadRef,
  type TurnUsage,
} from "./format.js"
export { normalizeToolOutput } from "./tool-output.js"
export { SessionCatalog, type CatalogEvent } from "./catalog.js"
export { SessionArchive } from "./archive.js"
export {
  connectDaemon,
  daemonMemoryUnsafe,
  daemonSocketPath,
  MAX_DAEMON_RSS,
  pingDaemon,
  PROTOCOL_VERSION,
  serveCatalog,
  type DaemonClient,
  type DaemonEvent,
  type DaemonStats,
} from "./daemon.js"
export {
  renderTranscript,
  renderTranscriptBundle,
  type TranscriptAsset,
  type TranscriptBundle,
  type TranscriptBundleMetadata,
  type TranscriptLoss,
  type TranscriptOptions,
  type TranscriptSpill,
} from "./transcript.js"
export {
  emitClaudeSession,
  emitCodexSession,
  emitCursorSession,
  emitGrokSession,
  type EmitResult,
} from "./emit.js"
export { type NativeFile, type SessionProvider } from "./providers/types.js"
export { CodexProvider } from "./providers/codex.js"
export { CursorProvider } from "./providers/cursor.js"
export { GrokProvider } from "./providers/grok.js"
export { ClaudeProvider } from "./providers/claude.js"
export { OpenCodeProvider } from "./providers/opencode.js"
import { SessionCatalog } from "./catalog.js"
import { CodexProvider } from "./providers/codex.js"
import { CursorProvider } from "./providers/cursor.js"
import { GrokProvider } from "./providers/grok.js"
import { DevinLocalProvider } from "./providers/devin-local.js"
import { DevinCliProvider } from "./providers/devin-cli.js"
import { ClaudeProvider } from "./providers/claude.js"
import { OpenCodeProvider } from "./providers/opencode.js"

/** The catalog with every built-in provider, ready to scan. */
export function defaultCatalog(
  options: { cachePath?: string; archivePath?: string } = {}
): SessionCatalog {
  const catalog = new SessionCatalog(
    [
      new CodexProvider(),
      new ClaudeProvider(),
      new CursorProvider(),
      new GrokProvider(),
      new OpenCodeProvider(),
      new DevinLocalProvider(),
      new DevinCliProvider(),
    ],
    options
  )
  return catalog
}

export { AttachmentContentSchema, AttachmentSourceSchema } from "./content.js"
export { ToolDetailSchema, describeToolDetails } from "./content.js"
export type { ToolDetail } from "./content.js"
export type { AttachmentContent } from "./content.js"

export { ThreadEntrySchema, ThreadRefSchema } from "./thread-schema.js"

export { attachmentFiles } from "./attachment-files.js"

export * from "./settings.js"
