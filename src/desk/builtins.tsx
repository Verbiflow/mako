import { AgentsPanel } from "@/components/inspector/agents-panel"
import { ControlPreviewOverlay } from "@/components/inspector/control-preview-overlay"
import { AppshotButton } from "@/components/composer/appshot-button"
import { ProviderConnectionNotice } from "@/components/composer/connection-notice"
import { AccountSwitchNotice } from "@/components/composer/account-notice"
import { ModelChoiceNotice } from "@/components/composer/model-notice"
import { SignInRecovery } from "@/components/composer/sign-in-recovery"
import { WorkspaceMoveCard } from "@/components/composer/workspace-move-card"
import { ControlPreviewPanel } from "@/components/inspector/control-preview-panel"
import {
  GitBranchIcon,
  MonitorIcon,
  FilesIcon,
  GitCompareIcon,
  TerminalSquareIcon,
} from "lucide-react"
import { planFeedbackOf } from "@mako/sessions/harnesses"
import { registerSlot, registerToolKindView, type ToolCall } from "@/extend/slots"
import { registerSurface } from "@/extend/surfaces"
import { IdentityRow } from "@/components/identity/identity-row"
import { ChangesPanel } from "@/components/inspector/changes-lazy"
import { FileTree } from "@/components/rail/file-tree"
import { TerminalPanel } from "@/components/inspector/terminal-lazy"
import {
  BashBody,
  EditBody,
  FileTarget,
  SkillBody,
  SubagentBody,
  WaitBody,
  WriteBody,
} from "@/components/transcript/tool-views"
import {
  countLines,
  editsOf,
  writtenText,
} from "@/lib/tools"

/**
 * The desk's own contributions, registered through exactly the same public
 * API an extension would use. Nothing here is privileged: an extension can
 * re-register any of these ids and take the surface over.
 */

export function installBuiltins(): () => void {
  const preload = window.requestIdleCallback(
    () => void import("@/components/inspector/changes-panel"),
    { timeout: 1_000 }
  )
  const disposers = [
    () => window.cancelIdleCallback(preload),
    registerSurface({
      id: "changes",
      label: "Changes",
      icon: GitCompareIcon,
      render: ChangesPanel,
      order: 0,
      minWidth: 400,
    }),
    registerSurface({
      id: "files",
      label: "Files",
      icon: FilesIcon,
      render: FileTree,
      order: 1,
    }),
    registerSurface({
      id: "terminal",
      label: "Terminal",
      icon: TerminalSquareIcon,
      render: TerminalPanel,
      order: 2,
      placement: "bottom",
      minHeight: 180,
    }),
    registerSurface({
      id: "control",
      label: "Control",
      icon: MonitorIcon,
      render: ControlPreviewPanel,
      order: 3,
      minWidth: 360,
    }),
    registerSurface({ id: "agents", label: "Agents", icon: GitBranchIcon, render: AgentsPanel, order: 4, minWidth: 360 }),
    // Identity, through the same slots a plugin would use. It lives in the
    // rail's footer and only there: the titlebar carried the same avatar six
    // inches away from it, and one account needs one place to be.
    registerSlot("identity", "rail.footer", IdentityRow, -10),
    registerSlot("control-preview", "transcript.overlay", ControlPreviewOverlay),
    registerSlot("appshot", "composer.controls", AppshotButton, -10),
    registerSlot("provider-connection", "composer.above", ProviderConnectionNotice),
    registerSlot("sign-in-recovery", "composer.above", SignInRecovery),
    registerSlot("account-switch", "composer.above", AccountSwitchNotice),
    registerSlot("model-choice", "composer.above", ModelChoiceNotice),
    registerSlot("workspace-move", "composer.above", WorkspaceMoveCard),

    // Views by the shared kind (packages/sessions/src/tool-identity.ts), so
    // every harness's shell, edit and agent draws the same row. The row's
    // summary is the identity's target unless a view says otherwise.
    registerToolKindView("shell", { body: BashBody }),
    ...(["edit", "delete", "move"] as const).map((kind) =>
      registerToolKindView(kind, {
        summary: (call: ToolCall) => {
          const edits = editsOf(call)
          return fileSummary(call, edits.length > 1 ? `${edits.length} edits` : undefined)
        },
        body: EditBody,
        openPath: (call: ToolCall) => call.tool.path,
      })
    ),
    registerToolKindView("write", {
      summary: (call: ToolCall) => {
        const lines = countLines(writtenText(call))
        return fileSummary(call, lines ? `${lines} ${lines === 1 ? "line" : "lines"}` : undefined)
      },
      body: WriteBody,
      openPath: (call: ToolCall) => call.tool.path,
    }),
    registerToolKindView("read", {
      summary: (call: ToolCall) => fileSummary(call),
      openPath: (call: ToolCall) => call.tool.path,
    }),
    registerToolKindView("plan-exit", {
      summary: (call: ToolCall) => {
        const feedback = planFeedbackOf(call.result)
        return feedback ? `You asked for changes: ${feedback}` : call.tool.target
      },
    }),
    registerToolKindView("skill", { body: SkillBody }),
    ...(["shell-output", "wait"] as const).map((kind) => registerToolKindView(kind, { body: WaitBody })),
    ...(["agent", "agent-message", "agent-wait", "agents"] as const).map((kind) =>
      registerToolKindView(kind, { body: SubagentBody })
    ),
  ]
  return () => disposers.forEach((dispose) => dispose())
}

function fileSummary(call: ToolCall, note?: string) {
  const path = call.tool.target ?? call.tool.path
  return path ? <FileTarget path={path} note={note} /> : note ?? ""
}
