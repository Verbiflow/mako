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
  entryChars,
  trimToolOutput,
  type BlockAddress,
  type EntryBlock,
  type Harness,
  type Thread,
  type ThreadEntry,
  type ThreadOrigin,
  type ThreadPage,
  type ThreadPageOptions,
  type ThreadRef,
  type TurnUsage,
} from "./format.js"
export { normalizeToolOutput } from "./tool-output.js"
export { SessionCatalog, type CatalogEvent } from "./catalog.js"
export { onDemandCatalogPaths } from "./catalog-identity.js"
export { SessionArchive } from "./archive.js"
export {
  connectDaemon,
  connectDaemonPort,
  daemonMemoryUnsafe,
  daemonSocketPath,
  MAX_DAEMON_RSS,
  pingDaemon,
  PROTOCOL_VERSION,
  serveCatalog,
  serveCatalogOnPort,
  type DaemonClient,
  type DaemonEvent,
  type DaemonPort,
  type DaemonStats,
  type ServeCatalogOptions,
} from "./daemon.js"
export { LineAssembler } from "./daemon-wire.js"
export {
  formatTranscript,
  renderTranscript,
  renderTranscriptBundle,
  type TranscriptAsset,
  type TranscriptDepth,
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
export {
  cursorLegacyIdentity,
  cursorSdkAgentDirectory,
  cursorSdkIndexPath,
  cursorSdkStateRoot,
  cursorSdkStorePath,
  cursorStoreOrigin,
  type CursorStoreOrigin,
} from "./providers/cursor-sdk-paths.js"
export {
  CURSOR_SDK_IMPORT_METADATA_KEY,
  cursorSdkAgentIdForDirectory,
  cursorSdkDirectoryName,
  readCursorSdkAgent,
  type CursorSdkAgentRecord,
  type CursorSdkImport,
} from "./providers/cursor-sdk-index.js"
export {
  cursorSdkReportedSettings,
  cursorSdkSelection,
  normalizeCursorSdkModels,
  type CursorSdkModelListItem,
  type CursorSdkModelSelection,
  type CursorSdkSelectionResult,
} from "./providers/cursor-sdk-models.js"
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
import { catalogCodeIdentity, catalogSharingIdentity } from "./catalog-identity.js"

// Freeze the implementation identity for this loaded module lifetime. A dev
// rebuild on disk must not make an old host claim it loaded the new readers.
const loadedCatalogCode = catalogCodeIdentity().catch(() => null)

function defaultProviders() {
  return [
    new CodexProvider(), new ClaudeProvider(), new CursorProvider(),
    new GrokProvider(), new OpenCodeProvider(), new DevinLocalProvider(),
    new DevinCliProvider(),
  ]
}

/** Compatibility for sharing discovery across installed and development hosts. */
export async function defaultCatalogIdentity(archivePath: string): Promise<string> {
  const code = await loadedCatalogCode
  if (!code) throw new Error("Cannot establish catalog reader compatibility")
  const providers = defaultProviders().map(provider => ({ harness: provider.harness, roots: provider.roots() }))
  return catalogSharingIdentity({ code, archivePath, providers })
}

/** The catalog with every built-in provider, ready to scan. */
export function defaultCatalog(
  options: { cachePath?: string; archivePath?: string } = {}
): SessionCatalog {
  const catalog = new SessionCatalog(
    defaultProviders(),
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

export { openCodeDatabasePaths } from "./providers/opencode-location.js"
