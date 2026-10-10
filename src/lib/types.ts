export type { NativeAuthoringTarget, NativeAuthoringCatalog, NativeAuthoringDocument, NativeAuthoringWrite, NativeAuthoringRemove } from "../../electron/contracts/native-authoring.ts"
export type { CommitAnalysisMode, CommitGenerationInput, CommitGenerationResult, UtilityConnection, UtilityConnectionInput, UtilityCatalog, UtilityCatalogInput, UtilityModel, UtilityModelSettings, UtilityProvider, UtilityProviderInfo } from "../../electron/contracts/utility-models.ts"
export type { NativeAgent, NativeAgentRoster } from "../../electron/contracts/native-agents.ts"
export type { NativeActivity } from "../../electron/contracts/native-activity.ts"
export type { LiveAction, LiveActionInput } from "../../electron/contracts/live-actions.ts"
export type { RewindPreview, RewindInput } from "../../electron/contracts/workspace-snapshots.ts"
export type { AccountHarness, AccountLogin, AccountLoginResult, AccountProvider, AccountRemoval, AccountRemovalEvent, AccountRemovalPlan, AccountRemovalSession, AccountUsage, AccountProviderInfo, HarnessAccount, UsageBalance, UsageResetCredits, ResetCreditOutcome, UsageWindow } from "../../electron/contracts/accounts.ts"
export type { TransferInput } from "../../electron/contracts/conversation-control.ts"
export type { HarnessDescriptor, LivePermissionRequest, PromptAttachment, LiveSessionCommand, LiveSessionMode, LiveSessionState, LiveSessionUsage, ContextBreakdown, ContextCategory, TokenCounts, LiveSteering, HarnessModel, HarnessModelOption, HarnessModelVariant, HarnessProfile, HarnessSelectValue } from "../../electron/contracts/providers-acp.ts"
export type { LiveUpdate } from "@mako/sessions/live-content"
export type { BlockAddress, EntryBlock, Harness, Thread, ThreadEntry, ThreadPage, ThreadRef, ThreadRunState, TurnUsage, Block, BlockType, ChatRole, ContextUsage, ModelCost, ModelInfo, ChatMessage, SessionMeta, SessionState, SessionSummary, ThinkingLevel, TokenStats, TreeNode } from "../../electron/contracts/conversation-session.ts"
export type { Automation, AutomationRun, AutomationTrigger, UpdateState, UsageSummary, UsageTotals } from "../../electron/contracts/automations-usage-updates.ts"
export type { BootPayload, ExternalThreadActivity, HostEvent, TabSnapshot } from "../../electron/contracts/host-events-boot.ts"
export type { Capabilities, CommandSummary, IntegrationCatalogSnapshot, IntegrationCategory, IntegrationConnection, IntegrationRecord, MakoComputerPermissions, CuaDriverStatus, McpProvider, McpRegistryProviderStatus, McpRegistrySnapshot, McpScope, McpServerDefinition, McpServerOrigin, McpServerRecord, McpSyncPreview, McpSyncTarget, McpTransport, SkillDelivery, SkillOrigin, SkillProvider, SkillProviderStatus, SkillRecord, SkillReference, SkillRegistrySnapshot, SkillScope, SkillSyncPreview, SkillSyncTarget, SkillSummary, ToolSummary } from "../../electron/contracts/mcp-skills-integrations.ts"
export type { ExternalEditor, FileContents, GitBinarySide, GitCommitEntry, GitCommitFile, GitDiff, GitDiffPreview, GitFile, GitFileStatus, GitStatus, GitPushInput, GitRemoteAction, GitRemoteInput, GitRemoteResult, GitHubStatus, CheckSummary, PullRequest, ReviewSummary, FileMatches, SearchOptions, SearchResults, ThreadMatches, StagedFile, WorkspaceFile } from "../../electron/contracts/git-workspace-search.ts"
export type { BrowserControlStatus, ControlActivity, ControlPreview, AppshotTarget, AppshotWindow, Appshot } from "@mako/control-runtime/contracts"
export type { DesktopNotification, NotificationDelivery, NotificationPermission } from "../../electron/contracts/notifications.ts"
export type { TerminalCreateOptions, TerminalEvent, TerminalSession, TerminalSessionStatus, TerminalSnapshot } from "../../electron/contracts/terminal.ts"

export { automationTriggerAvailable } from "../../electron/contracts/automations-usage-updates.ts"
export { THINKING_LEVELS } from "../../electron/contracts/conversation-session.ts"

export type { LiveSnapshot, LiveSummary, LiveBatch, LiveStartOptions, LiveRequest } from "../../electron/contracts/live-conversations"

export type { NativeRequest, NativeRequestInput } from "../../electron/contracts/native-requests"
export type { UtilityModelOption, UtilityTask, UtilityTaskState, UtilityWorkSettings } from "../../electron/contracts/utility-work"
export { AUTOMATIC as UTILITY_AUTOMATIC } from "../../electron/contracts/utility-work"
export type { ContinuationPlan, ContinuationResolution } from "../../electron/contracts/thread-continuation"
export type { Capability, LiveCapabilities, LiveCapabilityKey } from "../../electron/contracts/harness-capabilities"
export type { HarnessUsage, HarnessUsageKey } from "../../electron/contracts/harness-usage"

export type { AccessEnforcement, AccessTier } from "../../electron/contracts/access"
export type { Interruption, InterruptionReason, TurnContinuation } from "../../electron/contracts/live-conversations"
export type { MessageAnchor } from "../../electron/contracts/message-anchor"
export type {
  ProviderConnection,
  ProviderConnectionAction,
  ProviderConnectionSource,
  ProviderConnectionState,
} from "../../electron/contracts/provider-connection"
export type {
  CloudAccount,
  CloudAccountState,
  CloudDevice,
  CloudPerson,
  CloudSignedOutNotice,
} from "../../electron/contracts/cloud-account"
export type { ProviderFailure, ProviderFailureKind } from "../../electron/contracts/provider-failure"
