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
  contextFreeTitle,
  titleFrom,
  threadIdentity,
  userTextFrom,
  withTranscriptNote,
  withoutMakoFraming,
  entryChars,
  trimToolOutput,
  VIEWER_PAGE,
  type DecodedBlock,
  type DecodedEntry,
  type Harness,
  type Thread,
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
  backgroundCommandTurn,
  causeBody,
  outputBody,
  subagentLabel,
  subagentTurn,
  CODEX_GOAL,
  CODEX_GOAL_TURN,
  codexGoalTurn,
  outputTail,
  PROVIDER_TURN_FALLBACK,
  UNNAMED_TURN,
  type BackgroundCommandOutcome,
  type ProviderTurnCause,
  type SubagentOutcome,
} from "./provider-turn.js"
export { isOpenCodeInstruction, openCodeNoticeLabel, openCodeNoticeTurn, openCodeRetried, openCodeTurnFailed, type OpenCodeNotice } from "./providers/opencode-notice.js"
export { OPENCODE_PLAN_AGENT, openCodePlan } from "./providers/opencode-plan.js"
export { OpenCodeEditInput, openCodeFailedExit, openCodeFileName, openCodeToolDetails } from "./providers/opencode-tools.js"
export { DEVIN_PLAN_APPROVE, DevinExitPlanMetaSchema, DevinPlanCallSchema, DevinPlanTracker, DevinPlanUpdates, type DevinPlanCall, type DevinProposedPlan } from "./providers/devin-plans.js"
export { SessionCatalog, type CatalogEvent } from "./catalog.js"
export { translatorBuild } from "./translator.js"
export { onDemandCatalogPaths } from "./catalog-identity.js"
export { SessionArchive, archiveMigrationStatus, archiveStanding, type ArchiveMigrationCounts, type ArchiveReclaim } from "./archive.js"
export { ArchiveMigration, type ArchiveMigrationReport, type ArchiveMigrationSource } from "./archive-migration.js"
export { KeptRestoreSchema, type KeptRestore } from "./kept-restore.js"
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
  buildTranscript,
  exceeds,
  opensTurn,
  PAYLOAD_LIMITS,
  previewLines,
  PROSE_LIMITS,
  STEER_LINES,
  steeredMessages,
  steersShown,
  transcriptNote,
  transcriptTurns,
  writeTranscript,
  type BuiltTranscript,
  type SteeredMessage,
  type TranscriptChild,
  type TranscriptInput,
  type TranscriptLimits,
  type TranscriptOptions,
} from "./transcript-builder.js"
export { ChildSidecars, toolIdsOf, type BundledChildren, type ChildParent, type ChildSource } from "./child-sidecars.js"
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
export { claudeTaskOutput, claudeTaskOutputTail, type TaskOutput } from "./providers/claude-task-output.js"
export { cursorTerminalEnd, type CursorTerminalEnd } from "./providers/cursor-terminal.js"
export { KEPT_OUTPUTS_BUDGET, KeptOutputs, keptOutputsPath, keptOutputsStanding, type KeptOutput, type OutputKey, type OutputOrigin } from "./kept-outputs.js"
export { claudeApiErrorEvent } from "./providers/claude-events.js"
export { OpenCodeProvider } from "./providers/opencode.js"
import type { AttachmentReaders } from "./attachment-sweep.js"
import { SessionCatalog } from "./catalog.js"
import type { BackfillLog } from "./record-backfill.js"
import { catalogCodeIdentity, catalogSharingIdentity } from "./catalog-identity.js"
import { DecodeAside } from "./decode-aside.js"
import { NativeStores } from "./read-only-sqlite.js"
import type { SessionProvider } from "./providers/types.js"
import { SAVED_HISTORY_READERS, type SavedHistoryReader } from "./readers.js"

export { SAVED_HISTORY_READERS, type ReaderPlace, type SavedHistoryReader } from "./readers.js"
export { makoViews, pageOf, ThreadView, View, ViewCache, VIEW_CACHE_BYTES, type SessionView, type ViewCacheStats, type ViewMeta, type ViewPage, type ViewSummary } from "./view-cache.js"
export { RecordReads, RESTORED } from "./record-reads.js"

/**
 * The reader code this process loaded, which it pins once as it starts and
 * passes to `defaultCatalogIdentity`, so a dev rebuild on disk later can't
 * make an old process claim it loaded the new readers.
 */
export function loadedCatalogCode(): Promise<string | null> {
  return catalogCodeIdentity().catch(() => null)
}

/** Compatibility for sharing discovery across installed and development hosts. */
export async function defaultCatalogIdentity(
  archivePath: string,
  loadedCode: Promise<string | null>,
  readers: readonly SavedHistoryReader[] = SAVED_HISTORY_READERS
): Promise<string> {
  const code = await loadedCode
  if (!code) throw new Error("Cannot establish catalog reader compatibility")
  const providers = named(readers).map(provider => ({ harness: provider.harness, roots: provider.roots() }))
  return catalogSharingIdentity({ code, archivePath, providers })
}

/** The harnesses whose saved conversations these readers read. */
export function readableHarnesses(readers: readonly SavedHistoryReader[] = SAVED_HISTORY_READERS): string[] {
  return [...new Set(named(readers).map((provider) => provider.harness))]
}

/** Readers made only to say which harness and folders they read; they open nothing. */
function named(readers: readonly SavedHistoryReader[]): SessionProvider[] {
  const stores = new NativeStores(true)
  return readers.map((reader) => reader(stores))
}

/**
 * A catalog over `readers`, Mako's own unless given, ready to scan.
 * `readOnly` writes neither the archive nor any harness's store, and its
 * readers open every native store read-only at the file level.
 */
export function defaultCatalog(
  options: {
    cachePath?: string
    archivePath?: string
    recordsPath?: string
    viewsPath?: string
    readOnly?: boolean
    /** Take every session in the rail into the record store (`RecordBackfill`); for the catalog worker only. */
    backfill?: boolean
    log?: BackfillLog
    readers?: readonly SavedHistoryReader[]
    /** Runs a large record's decode as Node in a child process (`DecodeAside`); this process's own executable by default. */
    decodeExecutable?: string
    /** The host's installed readings, which stamp a write heard as it lands (`makoRuntimeReadings()`). */
    runtimeReadings?: string
    /** How this build stamps a store format it sets (`storeWriter`). */
    writer?: string
    /** Every reader's stores on this machine, for the backfill's sweep of Mako's attachment files (`AttachmentSweep`). */
    attachmentReaders?: () => Promise<AttachmentReaders>
  } = {}
): SessionCatalog {
  const { readers = SAVED_HISTORY_READERS, decodeExecutable, ...rest } = options
  const stores = new NativeStores(rest.readOnly ?? false)
  const decodeAside = readers === SAVED_HISTORY_READERS ? new DecodeAside(decodeExecutable) : undefined
  return new SessionCatalog(readers.map((reader) => reader(stores)), { ...rest, readBack: { readers, stores }, decodeAside })
}

export { AttachmentContentSchema, AttachmentSourceSchema } from "./content.js"
export { ToolDetailSchema, describeToolDetails } from "./content.js"
export type { ToolDetail } from "./content.js"
export { REVIEW_FENCE, ReviewFindingSchema, ReviewReportSchema, claudeReviewReport, codexReviewEcho, codexReviewReport, codexReviewText, makoReviewReport } from "./review.js"
export type { ReviewFinding, ReviewReport } from "./review.js"
export type { AttachmentContent } from "./content.js"

export { DecodedEntrySchema, StoredEntriesSchema, ThreadRefSchema } from "./thread-schema.js"
export { DECODE_ASIDE_BYTES, DecodeAside, type AsideJob, type AsideOutcome } from "./decode-aside.js"
export { EntrySchema, RecordRefSchema, entryAttachments, isReplyEntry } from "./entries.js"
export type { Entry, EntryOf, RecordRef, ReplyEntry, ToolEntry } from "./entries.js"
export { entriesFromMessages, messagesFromEntries, placeOf } from "./entry-sink.js"

export {
  CHILD_LIMIT,
  ChildStateSchema,
  ChildTranscriptSchema,
  ChildTranscriptsSchema,
  childStateCounts,
  type ChildState,
  type ChildTranscript,
  type ChildTranscripts,
} from "./children.js"
export { childCompleteness, formatChildCompleteness, type ChildCompleteness, type ChildFailure } from "./child-completeness.js"

export { attachmentFiles } from "./attachment-files.js"

export type { RecordLines, RecordPlace, RecordRoot, SessionRecords } from "./harness-records.js"
export { extraRoot } from "./record-roots.js"
export { EntryOriginalSchema, readOriginal, readStreamOriginal, type EntryOriginal, type OriginalPart, type OriginalValue } from "./record-original.js"
export {
  RecordStore,
  type CaptureInput,
  type CaptureReport,
  type RestoreInput,
  type RestoreReport,
  type RestoreAction,
  type RestoreRows,
} from "./record-store.js"

export * from "./settings.js"
export * from "./events.js"

export { openCodeDatabasePaths } from "./providers/opencode-location.js"
export { devinCliDirectory, devinDataHome } from "./providers/devin-location.js"
export { claudeTranscriptRoots } from "./providers/claude-location.js"
