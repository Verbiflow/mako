/**
 * @mako/sessions — one format for coding-agent sessions.
 *
 * Reads every supported harness's native session store, keeps a live catalog
 * of all of them, and renders any thread for continuation on any other
 * harness. Pure library: node builtins only, no Electron, no UI, so anything
 * — this desktop app, a CLI, a server — can hold the same catalog.
 */

export {
  agentTitleFrom,
  titleFrom,
  threadIdentity,
  userTextFrom,
  withContext,
  withoutMakoFraming,
  clip,
  entryChars,
  trimToolOutput,
  VIEWER_PAGE,
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
  type UnreadRecord,
} from "./format.js"
export { normalizeToolOutput } from "./tool-output.js"
export {
  backgroundCommandLabel,
  subagentLabel,
  PROVIDER_TURN_FALLBACK,
  type BackgroundCommandOutcome,
  type SubagentOutcome,
} from "./provider-turn.js"
export { isOpenCodeInstruction, openCodeNoticeLabel, openCodeTurnFailed, type OpenCodeNotice } from "./providers/opencode-notice.js"
export { OPENCODE_PLAN_AGENT, openCodePlan } from "./providers/opencode-plan.js"
export { OpenCodeEditInput, openCodeFailedExit, openCodeFileName, openCodeToolDetails } from "./providers/opencode-tools.js"
export { DEVIN_PLAN_APPROVE, DevinExitPlanMetaSchema, DevinPlanCallSchema, DevinPlanTracker, DevinPlanUpdates, type DevinPlanCall, type DevinProposedPlan } from "./providers/devin-plans.js"
export { SessionCatalog, type CatalogEvent } from "./catalog.js"
export { onDemandCatalogPaths } from "./catalog-identity.js"
export { SessionArchive, keepEverything } from "./archive.js"
export type { EvictionPolicy } from "./archive.js"
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
  emitDevinSession,
  emitGrokSession,
  openCodeImport,
  type EmitResult,
  type OpenCodeImport,
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
  CURSOR_PLAN_OPTION,
  cursorSdkReportedSettings,
  cursorSdkSelection,
  normalizeCursorSdkModels,
  type CursorSdkModelListItem,
  type CursorSdkSelectionResult,
} from "./providers/cursor-sdk-models.js"
export type { CursorSdkModelSelection } from "./cursor-sdk-content.js"
export { GrokProvider, grokErrorLabel, grokHome, grokTurnCause, grokUpdateMarker, grokWorkspaceCwd } from "./providers/grok.js"
export { ClaudeProvider } from "./providers/claude.js"
export { claudeApiErrorEvent } from "./providers/claude-events.js"
export { OpenCodeProvider } from "./providers/opencode.js"
import { SessionCatalog } from "./catalog.js"
import type { EvictionPolicy } from "./archive.js"
import { catalogCodeIdentity, catalogSharingIdentity } from "./catalog-identity.js"
import { restrictNativeStores } from "./read-only-sqlite.js"
import { SAVED_HISTORY_READERS, type SavedHistoryReader } from "./readers.js"

export { SAVED_HISTORY_READERS, type SavedHistoryReader } from "./readers.js"

// Freeze the implementation identity for this loaded module lifetime. A dev
// rebuild on disk must not make an old host claim it loaded the new readers.
const loadedCatalogCode = catalogCodeIdentity().catch(() => null)

/** Compatibility for sharing discovery across installed and development hosts. */
export async function defaultCatalogIdentity(
  archivePath: string,
  readers: readonly SavedHistoryReader[] = SAVED_HISTORY_READERS
): Promise<string> {
  const code = await loadedCatalogCode
  if (!code) throw new Error("Cannot establish catalog reader compatibility")
  const providers = readers.map((reader) => reader()).map(provider => ({ harness: provider.harness, roots: provider.roots() }))
  return catalogSharingIdentity({ code, archivePath, providers })
}

/** The harnesses whose saved conversations these readers read. */
export function readableHarnesses(readers: readonly SavedHistoryReader[] = SAVED_HISTORY_READERS): string[] {
  return [...new Set(readers.map((reader) => reader().harness))]
}

/**
 * A catalog over `readers`, Mako's own unless given, ready to scan.
 * `readOnly` writes neither the archive nor any harness's store, and from
 * then on this process opens every native store read-only at the file level.
 */
export function defaultCatalog(
  options: {
    cachePath?: string
    archivePath?: string
    eviction?: EvictionPolicy
    readOnly?: boolean
    readers?: readonly SavedHistoryReader[]
  } = {}
): SessionCatalog {
  const { readers = SAVED_HISTORY_READERS, ...rest } = options
  if (rest.readOnly) restrictNativeStores()
  return new SessionCatalog(readers.map((reader) => reader()), rest)
}

export { AttachmentContentSchema, AttachmentSourceSchema } from "./content.js"
export { ToolDetailSchema, describeToolDetails } from "./content.js"
export type { ToolDetail } from "./content.js"
export type { AttachmentContent } from "./content.js"

export { ThreadEntrySchema, ThreadRefSchema } from "./thread-schema.js"

export { attachmentFiles } from "./attachment-files.js"

export {
  captureRecords,
  restoreRecords,
  encodeSegment,
  decodeSegment,
  segmentId,
  type RecordSegment,
  type RecordsCursor,
  type SessionRecords,
} from "./harness-records.js"

export * from "./settings.js"
export * from "./events.js"

export { openCodeDatabasePaths } from "./providers/opencode-location.js"
export { devinCliDirectory, devinDataHome } from "./providers/devin-location.js"
export { claudeTranscriptRoots } from "./providers/claude-location.js"
