import { AgentsPanel } from "@/components/inspector/agents-panel"
import { SetupPanel, SetupReading } from "@/components/inspector/setup-panel"
import { useSetupOffered } from "@/components/inspector/setup-offered"
import { setSetupDrafter, setupDrafter } from "@/state/setup"
import { actions } from "@/state/session"
import { ControlPreviewOverlay } from "@/components/inspector/control-preview-overlay"
import { AppshotButton } from "@/components/composer/appshot-button"
import { AppshotShortcutHost } from "@/components/composer/appshot-flight"
import { ElementPickButton, ElementPickDialog } from "@/components/composer/element-pick-button"
import { installComposerNotices } from "@/desk/notices"
import { elementPicks, elementPicksStore } from "@/state/element-picks"
import { ControlPreviewPanel } from "@/components/inspector/control-preview-panel"
import { SimulatorPanel } from "@/components/inspector/simulator-panel"
import { simulatorSetupStore } from "@/state/simulator-setup"
import { simulators, simulatorsRunnable, simulatorsStore } from "@/state/simulators"
import {
  MonitorIcon,
  PackageIcon,
  FilesIcon,
  GitCompareIcon,
  SmartphoneIcon,
  TerminalSquareIcon,
} from "lucide-react"
import { planFeedbackOf } from "@mako/sessions/harnesses"
import { registerSlot, registerToolKindView, type ToolCall } from "@/extend/slots"
import { registerCommand } from "@/extend/commands"
import { QuoteReplyOverlay } from "@/components/transcript/quote-reply"
import { quoteSelectionCommand } from "@/components/transcript/quote-reply-selection"
import { registerSurface } from "@/extend/surfaces"
import { IdentityRow } from "@/components/identity/identity-row"
import { ChangesPanel } from "@/components/inspector/changes-lazy"
import { AgentsReading, ChangesReading, ControlReading } from "@/components/stage/side-readings"
import { useAgentsOffered } from "@/state/agents-offered"
import { ApexMark } from "@/components/ui/apex-mark"
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
import { callFacts, factsNote } from "@/lib/tools"

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
      reading: ChangesReading,
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
      reading: ControlReading,
    }),
    registerSurface({ id: "agents", label: "Agents", icon: ApexMark, render: AgentsPanel, order: 4, reading: AgentsReading, useOffered: () => useAgentsOffered() }),
    registerSurface({ id: "setup", label: "Setup", icon: PackageIcon, render: SetupPanel, order: 6, reading: SetupReading, useOffered: useSetupOffered }),
    installSetupDrafter(),
    installSimulatorSurface(),
    // Identity, through the same slots a plugin would use. It lives in the
    // rail's footer and only there: the titlebar carried the same avatar six
    // inches away from it, and one account needs one place to be.
    registerSlot("identity", "rail.footer", IdentityRow, -10),
    registerSlot("control-preview", "transcript.overlay", ControlPreviewOverlay),
    // Quoting an answer: the floating button over a selection, and the same as a chord.
    registerSlot("quote-reply", "transcript.overlay", QuoteReplyOverlay),
    registerCommand(quoteSelectionCommand),
    registerSlot("appshot", "composer.controls", AppshotButton, -10),
    // The global capture shortcut: held while a window is open, and the capture's flight into the draft.
    registerSlot("appshot-shortcut", "titlebar.trailing", AppshotShortcutHost),
    // Pointing at an element in a browser tab: the + menu's row, the line
    // while a pick runs, and the palette's chooser.
    registerSlot("element-pick", "composer.controls", ElementPickButton, -9),
    registerSlot("element-pick-dialog", "titlebar.trailing", ElementPickDialog),
    registerCommand({
      id: "element-pick.choose",
      title: "Pick an element in the browser",
      section: "Workspace",
      keywords: "select element inspect browser tab chrome component dom picker",
      run: () => elementPicks.choose(true),
    }),
    registerCommand({
      id: "element-pick.cancel",
      title: "Cancel the element pick",
      section: "Workspace",
      when: () => Boolean(elementPicksStore.get().active),
      run: () => elementPicks.cancel(),
    }),
    ...installComposerNotices(),

    // Views by the shared kind (packages/sessions/src/tool-identity.ts), so
    // every harness's shell, edit and agent draws the same row. The row's
    // summary is the identity's target unless a view says otherwise.
    registerToolKindView("shell", { body: BashBody }),
    // A file row says how much it read or changed after the file, in the label face: ":120–180", "+12 −3".
    ...(["edit", "delete", "move"] as const).map((kind) =>
      registerToolKindView(kind, {
        summary: (call: ToolCall) => {
          const files = callFacts(call).files
          return files ? filesSummary(files, factsNote(call)) : fileSummary(call, factsNote(call))
        },
        body: EditBody,
        openPath: (call: ToolCall) => call.tool.path,
      })
    ),
    registerToolKindView("write", {
      summary: (call: ToolCall) => fileSummary(call, factsNote(call)),
      body: WriteBody,
      openPath: (call: ToolCall) => call.tool.path,
    }),
    registerToolKindView("read", {
      summary: (call: ToolCall) => fileSummary(call, factsNote(call)),
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

/**
 * The words written into the composer that's on screen once the new Thread's frame is drawn; true when a composer took
 * them (it marks the event handled), so a draft nobody received isn't taken for one.
 */
function composeDraft(text: string): Promise<boolean> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(!window.dispatchEvent(new CustomEvent("mako:compose", { detail: { text }, cancelable: true })))))
}

/** Setup's requests (a tool into the recipe, a file into its carry) start a Thread of the project with the words written. */
function installSetupDrafter(): () => void {
  setSetupDrafter(setupDrafter((root) => actions.newConversationIn(root), composeDraft))
  return () => setSetupDrafter(undefined)
}

/** The simulator panel, offered only while a host here can run one: until then Settings › Simulators sets one up. */
function installSimulatorSurface(): () => void {
  let unregister: (() => void) | undefined
  const sync = () => {
    const runnable = simulatorsRunnable(simulatorsStore.get().listed)
    if (runnable && !unregister) unregister = registerSurface({ id: "simulator", label: "Simulator", icon: SmartphoneIcon, render: SimulatorPanel, order: 5 })
    else if (!runnable && unregister) {
      unregister()
      unregister = undefined
    }
  }
  const stopListening = simulatorsStore.subscribe(sync)
  let setup = simulatorSetupStore.get().setup
  // The setup line changing (Xcode installed, the tools in) is when a host may have become able to run one.
  const stopSetup = simulatorSetupStore.subscribe(() => {
    if (simulatorSetupStore.get().setup === setup) return
    setup = simulatorSetupStore.get().setup
    void simulators.load()
  })
  void simulators.load()
  return () => {
    stopListening()
    stopSetup()
    unregister?.()
  }
}

function fileSummary(call: ToolCall, note?: string) {
  const path = call.tool.target ?? call.tool.path
  return path ? <FileTarget path={path} note={note} /> : note ?? ""
}

/** A patch of several files: how many, then what it changed in all of them. */
function filesSummary(files: number, note?: string) {
  return <>{files} files{note ? <span className="text-label"> {note}</span> : null}</>
}
