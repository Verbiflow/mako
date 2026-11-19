import { createElement, useState, type ComponentType } from "react"
import { editLines, fileLines, type DiffLine } from "@/lib/tool-diff"
import { useVisible } from "@/components/transcript/use-visible"
import { Prose } from "@/components/transcript/markdown"
import { type ToolViewProps } from "@/extend/slots"
import { Ending, Output } from "@/components/transcript/tool-row"
import type { MakoToolGroup, ToolKind } from "@mako/sessions/tool-identity"
import {
  argAt,
  editsOf,
  normalizeToolOutput,
  parseToolExecutionOutput,
  subagentResultId,
  subagentResultText,
  subagentStanding,
  type SubagentStanding,
  writtenText,
} from "@/lib/tools"
import { cn } from "@/lib/utils"
import { fileDir, fileName } from "@/lib/format"
import {
  AppWindowIcon,
  ArrowLeftRightIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  CloudIcon,
  CodeIcon,
  FolderGit2Icon,
  GitPullRequestIcon,
  HistoryIcon,
  NetworkIcon,
  ScrollTextIcon,
  ScanSearchIcon,
  CircleHelpIcon,
  FolderInputIcon,
  Trash2Icon,
  ClockIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderTreeIcon,
  GlobeIcon,
  ImageIcon,
  ListChecksIcon,
  MonitorCogIcon,
  PlugIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react"
import { Shimmer } from "@/components/ui/shimmer"

/** Icon by kind, so the transcript is scannable without reading labels. */
const ICONS = {
  shell: SquareTerminalIcon,
  "shell-output": SquareTerminalIcon,
  "shell-input": SquareTerminalIcon,
  "shell-stop": SquareTerminalIcon,
  read: FileTextIcon,
  edit: FilePenLineIcon,
  write: FilePlusIcon,
  delete: Trash2Icon,
  move: FolderInputIcon,
  list: FolderTreeIcon,
  search: SearchIcon,
  find: SearchIcon,
  "web-fetch": GlobeIcon,
  "web-search": GlobeIcon,
  code: CodeIcon,
  computer: MonitorCogIcon,
  agent: BotIcon,
  "agent-message": BotIcon,
  "agent-wait": BotIcon,
  agents: BotIcon,
  todo: ListChecksIcon,
  plan: ListChecksIcon,
  "plan-exit": ListChecksIcon,
  question: CircleHelpIcon,
  review: ScanSearchIcon,
  "tool-search": SearchIcon,
  skill: BookOpenIcon,
  mcp: PlugIcon,
  mode: ArrowLeftRightIcon,
  think: BrainIcon,
  image: ImageIcon,
  wait: ClockIcon,
  other: WrenchIcon,
} satisfies { readonly [Kind in ToolKind]: ComponentType<{ className?: string }> }

/** Mako's own tools by what they're about: an agents tool draws as the agent kinds do, the rest as what they act on. */
const MAKO_ICONS = {
  agents: BotIcon,
  "pull-request": GitPullRequestIcon,
  app: AppWindowIcon,
  worktree: FolderGit2Icon,
  recipe: ScrollTextIcon,
  history: HistoryIcon,
  media: ImageIcon,
  port: NetworkIcon,
  cloud: CloudIcon,
  other: PlugIcon,
} satisfies { readonly [Group in MakoToolGroup]: ComponentType<{ className?: string }> }

/**
 * Resolves a tool's glyph: a registered view's override first, then a Mako
 * tool's, then the kind's. Rendering it through a component (rather than picking a component
 * type at the call site) keeps the element type stable across renders.
 */
export function ToolGlyph({
  kind,
  override,
  mako,
  className,
}: {
  kind: ToolKind
  override?: ComponentType<{ className?: string }>
  /** For a tool of Mako's own server, what it's about (`makoToolGroup`). */
  mako?: MakoToolGroup
  className?: string
}) {
  return createElement(override ?? (mako ? MAKO_ICONS[mako] : ICONS[kind]), { className })
}

/* ------------------------------------------------------------------ */
/* diff rendering                                                      */
/* ------------------------------------------------------------------ */

/**
 * How many lines an opened Edit or Write draws at first, and how many each part of the rest holds once it's all asked
 * for. Every line is four elements, drawn in the commit that opens the row: a 5,000-line Write was 25,000 nodes in one
 * click. The first lines are what a reader opens the row to see; "Show all" brings the rest, a part at a time as each
 * nears the viewport (`RestOfLines`), so however long the file, a click draws a few hundred lines.
 */
const FIRST_LINES = 400
const PART_LINES = 200

function DiffLines({ lines }: { lines: readonly DiffLine[] }) {
  return lines.map((line, index) => (
    <div
      key={index}
      className={cn(
        "flex gap-2 px-2",
        line.kind === "add" && "bg-added/10 text-added",
        line.kind === "remove" && "bg-removed/10 text-removed",
        line.kind === "context" && "text-faint"
      )}
    >
      <span className="w-8 shrink-0 text-right text-label opacity-60 select-none">{line.oldLine ?? ""}</span>
      <span className="w-8 shrink-0 text-right text-label opacity-60 select-none">{line.newLine ?? ""}</span>
      <span className="w-2 shrink-0 opacity-60 select-none">
        {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
      </span>
      <span className="whitespace-pre">{line.text || " "}</span>
    </div>
  ))
}

/** A part of the lines past the first: room for them, at the height the first lines measured (a line never wraps), until it nears the viewport. */
function RestOfLines({ lines, lineHeight }: { lines: readonly DiffLine[]; lineHeight: number }) {
  const { ref, visible } = useVisible()
  return (
    <div ref={ref} style={visible ? undefined : { height: lines.length * lineHeight }}>
      {visible ? <DiffLines lines={lines} /> : null}
    </div>
  )
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  /** Once all are asked for: how tall a drawn line is, which the parts not yet drawn stand at. */
  const [lineHeight, showAll] = useState<number | null>(null)
  const rest = lines.length - FIRST_LINES
  const parts: DiffLine[][] = []
  if (lineHeight !== null) for (let from = FIRST_LINES; from < lines.length; from += PART_LINES) parts.push(lines.slice(from, from + PART_LINES))
  return (
    <div className="overflow-x-auto font-mono text-label leading-[1.6]">
      <DiffLines lines={rest > 0 ? lines.slice(0, FIRST_LINES) : lines} />
      {lineHeight !== null ? parts.map((part, index) => <RestOfLines key={index} lines={part} lineHeight={lineHeight} />) : null}
      {rest > 0 && lineHeight === null ? (
        <button
          type="button"
          onClick={(event) => showAll(event.currentTarget.previousElementSibling?.getBoundingClientRect().height ?? 18)}
          className="pressable sticky left-0 mt-1 flex items-center gap-1 px-2 py-0.5 font-sans text-label text-faint hover:text-foreground"
        >
          Show all {lines.length.toLocaleString()} lines
        </button>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* built-in views                                                      */
/* ------------------------------------------------------------------ */

export function EditBody({ call }: ToolViewProps) {
  const edits = editsOf(call)
  if (edits.length === 0) return <Output text={call.result ?? ""} />
  return (
    <div className="space-y-2">
      {edits.map((edit, index) => (
        <div key={index}>
          <DiffBlock lines={editLines(edit.oldText, edit.newText)} />
        </div>
      ))}
    </div>
  )
}

export function WriteBody({ call }: ToolViewProps) {
  const content = writtenText(call) ?? ""
  return <DiffBlock lines={fileLines("", content)} />
}

/** A subagent's standing in the words its row and its group say. */
const STANDING_WORDS = {
  working: "Running",
  waiting: "Waiting",
  done: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  "cut off": "Cut off",
  canceled: "Canceled",
} as const satisfies Record<SubagentStanding, string>

/** The dot beside it: sea only while it works, the diff hues once it has an outcome. */
const STANDING_DOTS = {
  working: "animate-live bg-sea",
  waiting: "bg-attention",
  done: "bg-added",
  failed: "bg-removed",
  stopped: "bg-foreground/25",
  "cut off": "bg-foreground/25",
  canceled: "bg-foreground/25",
} as const satisfies Record<SubagentStanding, string>

export function SubagentBody({ call }: ToolViewProps) {
  const task =
    argAt(call.arguments, "task") ??
    argAt(call.arguments, "prompt") ??
    argAt(call.arguments, "message")
  const role =
    argAt(call.arguments, "subagent_type") ??
    argAt(call.arguments, "role") ??
    argAt(call.arguments, "agent")
  const agentId =
    argAt(call.arguments, "agent_id") ??
    argAt(call.arguments, "agentId") ??
    argAt(call.arguments, "task_id") ??
    subagentResultId(call.result)
  const result = subagentResultText(call.result)
  const standing = subagentStanding(call)
  const stillRunning = standing === "working"
  const status = STANDING_WORDS[standing]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-label">
        <span
          className={cn(
            "size-1.5 rounded-full",
            STANDING_DOTS[standing]
          )}
        />
        <span className="text-muted-foreground">{status}</span>
        {role ? <span className="text-faint">{role}</span> : null}
        {agentId ? (
          <span
            className="min-w-0 truncate font-mono text-faint"
            title={agentId}
          >
            {agentId}
          </span>
        ) : null}
      </div>
      {task ? (
        <div>
          <p className="pb-1 text-label text-faint">Assignment</p>
          <Prose text={task} />
        </div>
      ) : null}
      {result ? (
        <div className="border-t border-hairline pt-2">
          <p className="pb-1 text-label text-faint">
            {call.isError ? "Error" : call.isCutOff ? "Before it ended" : "Transcript and result"}
          </p>
          <Prose text={result} />
        </div>
      ) : stillRunning ? (
        <p className="text-ui text-faint">Working in the background…</p>
      ) : null}
    </div>
  )
}

export function SkillBody({ call }: ToolViewProps) {
  const name =
    argAt(call.arguments, "skill") ?? argAt(call.arguments, "name") ?? "Skill"
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-ui text-foreground/90">
        <BookOpenIcon className="size-3.5 text-faint" />
        <span className="font-medium">{name}</span>
      </div>
      {call.result ? (
        <Output text={call.result} dense isError={call.isError} />
      ) : call.pending ? (
        <p className="text-ui text-faint"><Shimmer text="Loading instructions…" /></p>
      ) : null}
      <Ending call={call} />
    </div>
  )
}

export function WaitBody({ call }: ToolViewProps) {
  const execution = parseToolExecutionOutput(call.result)
  const output = execution?.output ?? normalizeToolOutput(call.result)
  return (
    <div className="space-y-2">
      {execution ? (
        <div className="flex items-center gap-2 text-label text-faint">
          <span className="size-1.5 rounded-full bg-positive" />
          <span>{execution.status}</span>
          {execution.duration ? <span>{execution.duration}</span> : null}
        </div>
      ) : null}
      {output ? (
        <Output text={output} dense isError={call.isError} />
      ) : call.pending ? (
        <p className="text-ui text-faint">Waiting for command…</p>
      ) : null}
      <Ending call={call} />
    </div>
  )
}

export function BashBody({ call }: ToolViewProps) {
  const command = call.tool.command ?? ""
  // A shell a code-mode script ran (Codex's `exec`) reports through the
  // script's own header; the command's output is what follows it.
  const result = parseToolExecutionOutput(call.result)?.output ?? call.result
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 font-mono text-label leading-[1.6] text-foreground/90">
        <span className="shrink-0 text-muted-foreground select-none">$</span>
        <span className="whitespace-pre-wrap">{command}</span>
      </div>
      {result ? (
        <Output text={result} isError={call.isError} running={call.pending} />
      ) : call.pending ? (
        <p className="text-ui"><Shimmer text="Running…" /></p>
      ) : !call.isCanceled && !call.isCutOff ? (
        <p className="text-ui text-faint">Completed with no text output.</p>
      ) : null}
      <Ending call={call} />
    </div>
  )
}

export function EditPreview({before, after}: {before: string; after: string}) {
  return <DiffBlock lines={editLines(before, after)} />
}

/**
 * A file as a row target: the name, then the folder it lives in, dimmer and
 * trimmed from the left so the nearest folders are the ones that stay. Inline
 * words, so they stay on the row's one line and truncate with the rest of it
 * (`ToolWords`); a box here would break that line in two, past the row.
 */
export function FileTarget({ path, note }: { path: string; note?: string }) {
  const folder = shortFolder(path)
  return (
    <span className="font-mono text-label">
      {fileName(path)}
      {folder ? <span className="opacity-60"> {folder}</span> : null}
      {note ? <span className="font-sans"> {note}</span> : null}
    </span>
  )
}

const HOME = /^\/(?:Users|home)\/[^/]+(?=\/|$)/
const FOLDER_DEPTH = 3

function shortFolder(path: string): string {
  const folder = fileDir(path).replace(HOME, "~")
  const parts = folder.split("/")
  return parts.length > FOLDER_DEPTH + 1 ? `…/${parts.slice(-FOLDER_DEPTH).join("/")}` : folder
}
