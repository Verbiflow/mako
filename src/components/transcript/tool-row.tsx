import { useCopy } from "@/components/ui/use-copy"
import { ActivityMark } from "@/components/ui/activity-mark"
import { toolKindActivity, type ToolIdentity, type ToolKind } from "@mako/sessions/tool-identity"
import { memo, useEffect, useState, type ComponentType } from "react"
import { useToolView, type ToolCall } from "@/extend/slots"
import {
  formatToolArguments,
  hasToolArguments,
  normalizeToolOutput,
} from "@/lib/tools"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import { useTranscriptSource } from "./source-context"
import { ToolDetails } from "./tool-details"
import { TranscriptAttachment } from "./attachment"
import { viewer } from "@/state/viewer"
import { loadThreadBlock } from "@/state/thread-viewing"
import { loadLiveHistoryDetail } from "@/state/live-history"
import {
  ChevronRightIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
} from "lucide-react"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { Shimmer } from "@/components/ui/shimmer"

/**
 * One tool invocation, collapsed to a single line by default. The row is the
 * transcript's rhythm section — it has to stay quiet at a glance and be
 * complete when opened. Every harness and kind draws the same line: glyph,
 * label, target, then whatever is still true about the call at the far end.
 */
export const ToolRow = memo(function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const dense = usePrefs((prefs) => prefs.denseTools)
  const source = useTranscriptSource()
  const view = useToolView(call)

  const summary = view?.summary ? view.summary(call) : toolTarget(call.tool)
  const openPath = view?.openPath?.(call)
  const Body = view?.body
  const server = toolServer(call.tool)
  // A page carries the head of each tool output; the rest is read when the
  // row opens, and the head stays on screen until it lands.
  const rest = open ? call.rest : undefined
  const threadPath = source.threadPath
  const liveId = source.liveId
  useEffect(() => {
    if (!rest) return
    let active = true
    const read = "live" in rest && liveId
      ? loadLiveHistoryDetail(liveId, rest.live.token, rest.live.at)
      : "at" in rest && threadPath ? loadThreadBlock(threadPath, rest.at)
      : Promise.reject(new Error("The source of this output is unavailable."))
    void read.then(() => { if (active) setReadError(null) }, error => {
      if (active) setReadError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [rest, threadPath, liveId, readAttempt])

  return (
    <div>
      <div className="group/tool -mx-1.5 flex min-w-0 items-center rounded-md transition-colors duration-100 hover:bg-fill-hover">
        <button
          type="button"
          aria-expanded={open}
          data-open={open || undefined}
          data-pending={call.pending || undefined}
          onClick={() => setOpen((value) => !value)}
          className="pressable flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-ui"
        >
          <LeadSlot call={call} open={open} icon={view?.icon} />
          <span className={cn("shrink-0", call.isError ? "text-negative" : "text-muted-foreground")}>
            {toolLabel(call.tool)}
          </span>
          {summary ? (
            <span className={cn("min-w-0 truncate text-faint", !view?.summary && CODE_KINDS.has(call.tool.kind) && "font-mono text-label")}>
              {summary}
            </span>
          ) : null}
          <span className="flex-1" />
          {server ? <span className="shrink-0 text-label text-faint/70">{server}</span> : null}
          <Status call={call} />
        </button>
        {openPath ? (
          <button
            type="button"
            title={`Open ${openPath}`}
            aria-label={`Open ${openPath}`}
            onClick={() =>
              void viewer.open(
                openPath,
                undefined,
                source.threadPath,
                source.liveId
              )
            }
            className="pressable mr-1 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover/tool:opacity-100 hover:text-foreground focus:opacity-100"
          >
            <FileTextIcon className="size-3" />
          </button>
        ) : null}
      </div>

      {open ? (
        <div data-tool-body className="ml-1.75 space-y-2 border-l border-hairline py-1.5 pl-3.75">
          {!rest && call.details?.length ? <ToolDetails details={call.details} /> : null}
          {!rest && (Body && !call.details?.some((detail) => detail.type === "diff") ? (
            <Body call={call} expanded />
          ) : (
            <DefaultBody call={call} dense={dense} />
          ))}
          {!rest && call.attachments?.length ? (
            <div className="space-y-2">
              {call.attachments.map((attachment, index) => (
                <TranscriptAttachment
                  key={attachment.id ?? index}
                  attachment={attachment}
                />
              ))}
            </div>
          ) : null}
          {rest ? (
            <p className="text-label">
              {readError ? <><span role="alert">{readError}</span>{" "}<button type="button" className="pressable underline" onClick={() => { setReadError(null); setReadAttempt(value => value + 1) }}>Try again</button></>
                : <Shimmer text={`Reading the rest of this output${rest.length ? ` · ${rest.length.toLocaleString()} characters` : ""}`} />}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

/** Kinds whose target is something you could paste into a terminal or editor. */
const CODE_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>([
  "shell", "shell-input", "read", "edit", "write", "delete", "move",
  "list", "search", "find", "code", "web-fetch",
])

/** An MCP tool's label without the server, which sits at the row's far end. */
function toolLabel(tool: ToolIdentity): string {
  const prefix = tool.server ? `${tool.server}: ` : ""
  if (!prefix || !tool.label.startsWith(prefix)) return tool.label
  const name = tool.label.slice(prefix.length)
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function toolServer(tool: ToolIdentity): string | undefined {
  return tool.kind === "mcp" || tool.kind === "computer" ? tool.server : undefined
}

/** The target, unless it only repeats the tool's own name. */
function toolTarget(tool: ToolIdentity): string {
  const target = tool.target ?? ""
  return tool.server && tool.tool && target === `${tool.server}: ${tool.tool}` ? "" : target
}

/**
 * One leading slot, two layers: the tool's glyph, and the chevron whenever
 * the pointer is near or the row is open. The glyph is what makes a row
 * scannable, so it shows from the first frame; the running state is the
 * mark at the end of the row, not a spinner in place of identity.
 * Crossfaded with CSS alone — no state, no re-render per token, and the row
 * never shifts because the slot is one fixed square.
 */
function LeadSlot({
  call,
  open,
  icon,
}: {
  call: ToolCall
  open: boolean
  icon?: ComponentType<{ className?: string }>
}) {
  const layer =
    "absolute inset-0 m-auto [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  return (
    <span className="relative size-3.5 shrink-0">
      <ToolGlyph
        kind={call.tool.kind}
        override={icon}
        className={cn(
          layer,
          "size-3.5",
          call.isError
            ? "text-negative"
            : call.pending
              ? "text-foreground/80"
              : "text-faint",
          open ? "opacity-0" : "opacity-100 group-hover/tool:opacity-0"
        )}
      />
      <ChevronRightIcon
        className={cn(
          layer,
          "size-3.5 text-faint",
          open
            ? "rotate-90 opacity-100"
            : "opacity-0 group-hover/tool:opacity-100"
        )}
      />
    </span>
  )
}

/** What is still true about the call, in words; only a running call moves. */
function Status({ call }: { call: ToolCall }) {
  if (call.pending) {
    return (
      <span role="status" aria-label="Running" className="shrink-0 text-muted-foreground">
        <ActivityMark state={toolKindActivity(call.tool.kind)} />
      </span>
    )
  }
  if (call.isError) return <span className="shrink-0 text-label text-negative">failed</span>
  if (call.isCanceled) return <span className="shrink-0 text-label text-faint">canceled</span>
  if (call.isCutOff) return <span className="shrink-0 text-label text-faint">cut off</span>
  return null
}

function DefaultBody({ call, dense }: { call: ToolCall; dense: boolean }) {
  const args = hasToolArguments(call.arguments)
  const input = args ? formatToolArguments(call.arguments) : ""

  return (
    <div className="space-y-2">
      {args ? (
        <CopyableBlock label="input" text={input}>
          <pre className="rounded bg-raised px-2 py-1.5 font-mono text-label leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {input}
          </pre>
        </CopyableBlock>
      ) : null}
      {call.isCanceled ? (
        <p className="text-ui text-faint">canceled</p>
      ) : call.result ? (
        <Output text={call.result} dense={dense} isError={call.isError} />
      ) : call.pending ? (
        <p className="text-ui"><Shimmer text="Waiting for result…" /></p>
      ) : !call.attachments?.length && !call.details?.length ? (
        <p className="text-ui text-faint">Completed with no text output.</p>
      ) : null}
    </div>
  )
}

const CLAMP = 12_000

export function Output({
  text,
  dense,
  isError,
}: {
  text: string
  dense?: boolean
  isError?: boolean
}) {
  const [full, setFull] = useState(false)
  const normalized = normalizeToolOutput(text)
  const clipped = !full && normalized.length > CLAMP

  return (
    <CopyableBlock label="output" text={normalized}>
      <pre
        className={cn(
          "font-mono text-label leading-[1.6] break-words whitespace-pre-wrap",
          dense ? "max-h-40 overflow-y-auto" : "max-h-[26rem] overflow-y-auto",
          isError ? "text-negative/90" : "text-muted-foreground"
        )}
      >
        {clipped ? `${normalized.slice(0, CLAMP)}\n…` : normalized}
      </pre>
      {clipped ? (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="mt-1 text-label text-muted-foreground hover:underline"
        >
          Show all {normalized.length.toLocaleString()} characters
        </button>
      ) : null}
    </CopyableBlock>
  )
}

/**
 * A block whose contents can leave. The copy affordance appears on hover in
 * the block's own corner — input and output each copy independently, whole
 * and unclipped, because "copy the answer" and "copy the command that
 * produced it" are different needs.
 */
function CopyableBlock({
  label,
  text,
  children,
}: {
  label: string
  text: string
  children: React.ReactNode
}) {
  const { copied, copy } = useCopy(text)
  return (
    <div className="group/copyblock relative">
      {children}
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copy()
        }}
        className={cn(
          "pressable absolute top-1 right-1 rounded-md bg-raised p-1 ring-1 ring-hairline backdrop-blur-sm",
          "text-faint transition-opacity duration-100 hover:text-foreground",
          copied
            ? "opacity-100"
            : "opacity-0 group-hover/copyblock:opacity-100 focus-visible:opacity-100"
        )}
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </button>
    </div>
  )
}
