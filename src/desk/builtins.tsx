import { AgentsPanel } from "@/components/inspector/agents-panel"
import { ControlPreviewOverlay } from "@/components/inspector/control-preview-overlay"
import { AppshotButton } from "@/components/composer/appshot-button"
import { ProviderConnectionNotice } from "@/components/composer/connection-notice"
import { ControlPreviewPanel } from "@/components/inspector/control-preview-panel"
import {
  GitBranchIcon,
  MonitorIcon,
  FilesIcon,
  GitCompareIcon,
  TerminalSquareIcon,
} from "lucide-react"
import { registerSlot, registerToolKindView, registerToolView, type ToolCall } from "@/extend/slots"
import { registerSurface } from "@/extend/surfaces"
import { IdentityRow } from "@/components/identity/identity-row"
import { ChangesPanel } from "@/components/inspector/changes-lazy"
import { FileTree } from "@/components/rail/file-tree"
import { TerminalPanel } from "@/components/inspector/terminal-lazy"
import {
  BashBody,
  EditBody,
  SkillBody,
  SubagentBody,
  WaitBody,
  WriteBody,
} from "@/components/transcript/tool-views"
import {
  argAt,
  countLines,
  editsOf,
  firstQuestion,
  primaryArgument,
  SUBAGENT_TOOLS,
} from "@/lib/tools"
import { fileName } from "@/lib/format"

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

    ...["bash", "Bash", "shell", "Shell", "exec_command"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => argAt(call.arguments, "command") ?? argAt(call.arguments, "cmd") ?? argAt(call.arguments, "description") ?? "",
        body: BashBody,
      })
    ),
    ...["edit", "Edit", "multiedit", "MultiEdit", "apply_patch"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => {
          const edits = editsOf(call)
          const path = primaryArgument(call.arguments)
          return edits.length > 1 ? `${path} · ${edits.length} edits` : path
        },
        body: EditBody,
        openPath: (call: ToolCall) =>
          primaryArgument(call.arguments) || undefined,
      })
    ),
    ...["write", "Write"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          `${primaryArgument(call.arguments)} · ${countLines(argAt(call.arguments, "content"))} lines`,
        body: WriteBody,
        openPath: (call: ToolCall) =>
          primaryArgument(call.arguments) || undefined,
      })
    ),
    ...["read", "Read", "ReadFile", "read_file"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => {
          const path = primaryArgument(call.arguments)
          return path ? fileName(path) : ""
        },
        openPath: (call: ToolCall) =>
          primaryArgument(call.arguments) || undefined,
      })
    ),
    ...["grep", "Grep", "rg", "find", "Glob", "glob"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => {
          const query =
            argAt(call.arguments, "pattern") ??
            argAt(call.arguments, "query") ??
            argAt(call.arguments, "glob_pattern")
          const path = primaryArgument(call.arguments)
          return [query, path].filter(Boolean).join(" · ")
        },
      })
    ),
    ...["ls", "list_files"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => primaryArgument(call.arguments) || ".",
      })
    ),
    ...["webfetch", "WebFetch", "web_search", "WebSearch"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => primaryArgument(call.arguments),
      })
    ),
    ...["Skill", "skill"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "skill") ??
          argAt(call.arguments, "name") ??
          primaryArgument(call.arguments),
        body: SkillBody,
      })
    ),
    ...["TaskCreate", "TaskUpdate", "TodoWrite", "updateTodos", "CreatePlan"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "subject") ??
          argAt(call.arguments, "title") ??
          argAt(call.arguments, "description") ??
          "Plan",
      })
    ),
    ...["AskQuestion", "AskUserQuestion", "question"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          firstQuestion(call.arguments) ??
          argAt(call.arguments, "question") ??
          argAt(call.arguments, "prompt") ??
          "Question",
      })
    ),
    registerToolView("wait", {
      summary: (call: ToolCall) => {
        const cell = argAt(call.arguments, "cell_id")
        return cell ? `Command ${cell}` : "Command output"
      },
      body: WaitBody,
    }),
    ...["ScheduleWakeup", "AwaitShell", "write_stdin", "ToolSearch"].map(
      (name) =>
        registerToolView(name, {
          summary: (call: ToolCall) => primaryArgument(call.arguments),
        })
    ),
    // Mako's control programs: the row reads the program's first line.
    ...["mako_browser_exec", "mako_computer_exec"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => {
          const source = argAt(call.arguments, "source")
          const line = source?.split("\n").find((entry) => entry.trim())
          return line?.trim() ?? primaryArgument(call.arguments)
        },
      })
    ),
    ...["mako_browser_help", "mako_computer_help"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "action") ??
          argAt(call.arguments, "tool") ??
          argAt(call.arguments, "method") ??
          argAt(call.arguments, "domain") ??
          "Reference",
      })
    ),
    ...SUBAGENT_TOOLS.map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "description") ??
          argAt(call.arguments, "title") ??
          argAt(call.arguments, "role") ??
          argAt(call.arguments, "subagent_type") ??
          argAt(call.arguments, "agent_id") ??
          argAt(call.arguments, "target") ??
          argAt(call.arguments, "cell_id") ??
          "Background agent",
        body: SubagentBody,
        icon: GitBranchIcon,
      })
    ),

    // The provider's own kind keeps a real body when the name is unknown to
    // the registry: an `execute` still renders a terminal, an `edit` a diff.
    registerToolKindView("execute", { body: BashBody }),
    ...["edit", "delete", "move"].map((kind) =>
      registerToolKindView(kind, {
        body: EditBody,
        openPath: (call: ToolCall) =>
          primaryArgument(call.arguments) || undefined,
      })
    ),
    registerToolKindView("read", {
      openPath: (call: ToolCall) =>
        primaryArgument(call.arguments) || undefined,
    }),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
