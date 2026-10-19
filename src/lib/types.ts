export type { AuthoringApplied, AuthoringCatalog, AuthoringChange, AuthoringDiffLine, AuthoringDraft, AuthoringEntry, AuthoringPlan, AuthoringSource, AuthoringTarget, AuthoringView, NativeAuthoringFamily } from "@mako/host/contracts/native-authoring"
export type { CommitAnalysisMode, CommitGenerationInput, CommitGenerationResult, UtilityConnection, UtilityConnectionInput, UtilityCatalog, UtilityCatalogInput, UtilityModel, UtilityModelSettings, UtilityProvider, UtilityProviderInfo } from "@mako/host/contracts/utility-models"
export type { NativeAgent, NativeAgentRoster } from "@mako/host/contracts/native-agents"
export type { NativeActivity } from "@mako/host/contracts/native-activity"
export type { LiveAction, LiveActionInput } from "@mako/host/contracts/live-actions"
export type { RewindPreview, RewindInput } from "@mako/host/contracts/workspace-snapshots"
export type { AccountHarness, AccountLogin, AccountLoginResult, AccountProvider, AccountRemoval, AccountRemovalEvent, AccountRemovalPlan, AccountRemovalSession, AccountUsage, AccountProviderInfo, HarnessAccount, UsageBalance, UsageResetCredits, ResetCreditOutcome, UsageWindow } from "@mako/host/contracts/accounts"
export type { TransferInput } from "@mako/host/contracts/conversation-control"
export type { HarnessDescriptor, LivePermissionRequest, PromptAttachment, LiveSessionCommand, LiveSessionMode, LiveSessionState, LiveSessionUsage, ContextBreakdown, ContextCategory, TokenCounts, LiveSteering, HarnessModel, HarnessModelOption, HarnessModelVariant, HarnessProfile, HarnessSelectValue } from "@mako/host/contracts/providers-acp"
export type { LiveUpdate } from "@mako/sessions/live-content"
export type { Entry, Harness, Thread, ThreadPage, ThreadRef, ThreadRunState, TurnUsage, Block, BlockType, ToolContentRest, ChatRole, ContextUsage, ModelCost, ModelInfo, ChatMessage, MessageOrigin, OriginEntry, SessionMeta, SessionState, SessionSummary, ThinkingLevel, TokenStats, TreeNode } from "@mako/host/contracts/conversation-session"
export type { Automation, AutomationRun, AutomationTrigger, UpdateState, UsageSummary, UsageTotals } from "@mako/host/contracts/automations-usage-updates"
export type { BootPayload, ExternalThreadActivity, HostEvent, TabSnapshot } from "@mako/host/contracts/host-events-boot"
export type { Capabilities, CommandSummary, IntegrationCatalogSnapshot, IntegrationCategory, IntegrationConnection, IntegrationRecord, MakoComputerPermissions, CuaDriverStatus, McpProvider, McpRegistryProviderStatus, McpRegistrySnapshot, McpScope, McpServerDefinition, McpServerOrigin, McpServerRecord, McpSyncPreview, McpSyncTarget, McpTransport, SkillDelivery, SkillOrigin, SkillProvider, SkillProviderStatus, SkillRecord, SkillReference, SkillRegistrySnapshot, SkillScope, SkillSyncPreview, SkillSyncTarget, SkillSummary, ToolSummary } from "@mako/host/contracts/mcp-skills-integrations"
export type { ExternalEditor, FileContents, GitBinarySide, GitCommitEntry, GitCommitFile, GitDiff, GitDiffPreview, GitFile, GitFileStatus, GitStatus, GitPushInput, GitRemoteAction, GitRemoteInput, GitRemoteResult, GitHubStatus, CheckSummary, PullRequest, ReviewSummary, FileMatches, SearchOptions, SearchResults, ThreadMatches, StagedFile, WorkspaceFile } from "@mako/host/contracts/git-workspace-search"
export type { BrowserControlStatus, ControlActivity, ControlPreview, AppshotTarget, AppshotWindow, Appshot } from "@mako/control-runtime/contracts"
export type { DesktopNotification, NotificationDelivery, NotificationPermission } from "@mako/host/contracts/notifications"
export type { TerminalCreateOptions, TerminalEvent, TerminalSession, TerminalSessionStatus, TerminalSnapshot } from "@mako/host/contracts/terminal"

export { automationTriggerAvailable } from "@mako/host/contracts/automations-usage-updates"
export { THINKING_LEVELS } from "@mako/host/contracts/conversation-session"

export type { LiveSnapshot, LiveSummary, LiveBatch, LiveStartOptions, LiveRequest } from "@mako/host/contracts/live-conversations"

export type { NativeRequest, NativeRequestInput } from "@mako/host/contracts/native-requests"
export type { UtilityModelOption, UtilityTask, UtilityTaskState, UtilityWorkSettings } from "@mako/host/contracts/utility-work"
export { AUTOMATIC as UTILITY_AUTOMATIC } from "@mako/host/contracts/utility-work"
export type { ContinuationPlan, ContinuationResolution } from "@mako/host/contracts/thread-continuation"
export type { Capability, LiveCapabilities, LiveCapabilityKey } from "@mako/host/contracts/harness-capabilities"
export type { HarnessUsage, HarnessUsageKey } from "@mako/host/contracts/harness-usage"

export type { AccessEnforcement, AccessTier } from "@mako/host/contracts/access"
export type { Interruption, InterruptionReason, TurnContinuation } from "@mako/host/contracts/live-conversations"
export type { MessageAnchor } from "@mako/host/contracts/message-anchor"
export type {
  ProviderConnection,
  ProviderConnectionAction,
  ProviderConnectionSource,
  ProviderConnectionState,
} from "@mako/host/contracts/provider-connection"
export type {
  CloudAccount,
  CloudAccountState,
  CloudDevice,
  CloudPerson,
  CloudSignedOutNotice,
} from "@mako/host/contracts/cloud-account"
export type { CloudKeptSignIn, CloudSignInRow, CloudSignInsState } from "@mako/host/contracts/cloud-sign-ins"
export type { ProviderFailure, ProviderFailureKind } from "@mako/host/contracts/provider-failure"
