import { createElement, type ComponentType } from "react"
import { Prose } from "@/components/transcript/markdown"
import { type ToolViewProps } from "@/extend/slots"
import { Output } from "@/components/transcript/tool-row"
import type { ToolKind } from "@mako/sessions/tool-identity"
import {
  argAt,
  booleanArgAt,
  editsOf,
  normalizeToolOutput,
  parseToolExecutionOutput,
  subagentResultId,
  subagentResultText,
  writtenText,
} from "@/lib/tools"
import { cn } from "@/lib/utils"
import {
  ArrowLeftRightIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  CodeIcon,
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
  "tool-search": SearchIcon,
  skill: BookOpenIcon,
  mcp: PlugIcon,
  mode: ArrowLeftRightIcon,
  think: BrainIcon,
  image: ImageIcon,
  wait: ClockIcon,
  other: WrenchIcon,
} satisfies { readonly [Kind in ToolKind]: ComponentType<{ className?: string }> }

/**
 * Resolves a tool's glyph: a registered view's override first, then the
 * kind's. Rendering it through a component (rather than picking a component
 * type at the call site) keeps the element type stable across renders.
 */
export function ToolGlyph({
  kind,
  override,
  className,
}: {
  kind: ToolKind
  override?: ComponentType<{ className?: string }>
  className?: string
}) {
  return createElement(override ?? ICONS[kind], { className })
}

/* ------------------------------------------------------------------ */
/* diff rendering                                                      */
/* ------------------------------------------------------------------ */

interface DiffLine {
  kind: "context" | "add" | "remove"
  text: string
  oldLine?: number
  newLine?: number
}

/**
 * Line diff by common prefix/suffix trimming. It is O(n) instead of an LCS,
 * which is exactly right here: an edit's old and new text already share their
 * head and tail, and the transcript only needs to show what moved.
 */
function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n")
  const right = after.split("\n")

  let head = 0
  while (
    head < left.length &&
    head < right.length &&
    left[head] === right[head]
  )
    head += 1

  let tail = 0
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1
  }

  const lines: DiffLine[] = []
  const context = 2
  for (let i = Math.max(0, head - context); i < head; i += 1) {
    lines.push({ kind: "context", text: left[i], oldLine: i + 1, newLine: i + 1 })
  }
  for (let i = head; i < left.length - tail; i += 1) {
    lines.push({ kind: "remove", text: left[i], oldLine: i + 1 })
  }
  for (let i = head; i < right.length - tail; i += 1) {
    lines.push({ kind: "add", text: right[i], newLine: i + 1 })
  }
  for (
    let i = left.length - tail;
    i < Math.min(left.length, left.length - tail + context);
    i += 1
  ) {
    lines.push({ kind: "context", text: left[i], oldLine: i + 1, newLine: right.length - left.length + i + 1 })
  }
  return lines
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-x-auto font-mono text-ui leading-[1.6]">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "flex gap-2 px-2.5",
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
      ))}
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
    <div className="divide-y divide-hairline py-1">
      {edits.map((edit, index) => (
        <div key={index} className="py-1.5">
          <DiffBlock lines={diffLines(edit.oldText, edit.newText)} />
        </div>
      ))}
    </div>
  )
}

export function WriteBody({ call }: ToolViewProps) {
  const content = writtenText(call) ?? ""
  return (
    <div className="py-1">
      <DiffBlock
        lines={content
          .split("\n")
          .map((text, index) => ({ kind: "add" as const, text, newLine: index + 1 }))}
      />
    </div>
  )
}

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
  const background =
    booleanArgAt(call.arguments, "background") === true ||
    booleanArgAt(call.arguments, "run_in_background") === true
  const stillRunning =
    call.pending ||
    (background &&
      /(?:working|running) in the background|state="running"/i.test(
        call.result ?? ""
      ))
  const status = call.isError
    ? "Failed"
    : call.isCanceled
      ? "Canceled"
      : call.isCutOff
        ? "Cut off"
        : stillRunning
        ? "Running"
        : "Completed"

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2">
      <div className="flex items-center gap-2 text-label">
        <span
          className={cn(
            "size-1.5 rounded-full",
            call.isError
              ? "bg-removed"
              : call.isCanceled || call.isCutOff
                ? "bg-foreground/25"
                : stillRunning
                  ? "animate-live bg-ember"
                  : "bg-added"
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
            {call.isError ? "Error" : call.isCutOff ? "No result" : "Transcript and result"}
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
    <div className="space-y-2 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-ui text-foreground/90">
        <BookOpenIcon className="size-3.5 text-faint" />
        <span className="font-medium">{name}</span>
      </div>
      {call.isCanceled ? (
        <p className="text-ui text-faint">canceled</p>
      ) : call.result ? (
        <Output text={call.result} dense isError={call.isError} />
      ) : call.pending ? (
        <p className="text-ui text-faint"><Shimmer text="Loading instructions…" /></p>
      ) : null}
    </div>
  )
}

export function WaitBody({ call }: ToolViewProps) {
  const execution = parseToolExecutionOutput(call.result)
  const output = execution?.output ?? normalizeToolOutput(call.result)
  return (
    <div className="space-y-2 px-2.5 py-2">
      {execution ? (
        <div className="flex items-center gap-2 text-label text-faint">
          <span className="size-1.5 rounded-full bg-positive" />
          <span>{execution.status}</span>
          {execution.duration ? <span>{execution.duration}</span> : null}
        </div>
      ) : null}
      {call.isCanceled ? (
        <p className="text-ui text-faint">canceled</p>
      ) : output ? (
        <Output text={output} dense isError={call.isError} />
      ) : call.pending ? (
        <p className="text-ui text-faint">Waiting for command…</p>
      ) : null}
    </div>
  )
}

export function BashBody({ call }: ToolViewProps) {
  const command = call.tool.command ?? ""
  // A shell a code-mode script ran (Codex's `exec`) reports through the
  // script's own header; the command's output is what follows it.
  const result = parseToolExecutionOutput(call.result)?.output ?? call.result
  return (
    <div className="space-y-1.5 px-2.5 py-2">
      <div className="flex gap-2 font-mono text-ui text-foreground/90">
        <span className="shrink-0 text-muted-foreground select-none">$</span>
        <span className="whitespace-pre-wrap">{command}</span>
      </div>
      {call.isCanceled ? (
        <p className="text-ui text-faint">canceled</p>
      ) : result ? (
        <Output text={result} isError={call.isError} />
      ) : call.pending ? (
        <p className="text-ui"><Shimmer text="Running…" /></p>
      ) : (
        <p className="text-ui text-faint">Completed with no text output.</p>
      )}
    </div>
  )
}

export function EditPreview({before, after}: {before: string; after: string}) {
  return <DiffBlock lines={diffLines(before, after)} />
}
