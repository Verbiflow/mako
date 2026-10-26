import { useState } from "react"
import { RotateCcwIcon } from "lucide-react"
import type { RewindWriter } from "@mako/host/contracts/workspace-snapshots"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { acp, useAcp } from "@/state/acp"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { useThreadTitles } from "@/state/thread-titles"
import type { RewindPreview } from "@/lib/types"

type PreviewState =
  | { kind: "loading" }
  | {
      kind: "ready"
      sourceId: string
      preview: RewindPreview
      operationId: string
    }
  | { kind: "error"; message: string }

export function RewindButton({
  requestId,
  position = "after",
}: {
  requestId: string
  position?: "before" | "after"
}) {
  const scope = useConversationScope()
  const snapshots = useAcp(
    (state) =>
      scopedLiveAcp(state, scope)?.requests?.find(
        (request) => request.id === requestId
      )?.snapshots
  )
  const thread = useAcp((state) => scopedLiveAcp(state, scope)?.threadId)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PreviewState>({ kind: "loading" })
  const [busy, setBusy] = useState(false)
  if (!snapshots) return null
  const boundary = snapshots[position]
  const pointLabel =
    position === "before" ? "before this prompt" : "after this answer"
  // A checkpoint that couldn't be taken still opens, to say why; one being written can't yet.
  const refused = boundary?.kind === "unavailable" ? boundary.reason : undefined
  async function load() {
    setState({ kind: "loading" })
    try {
      const result = await acp.previewRewind(requestId, position)
      setState({ kind: "ready", ...result, operationId: crypto.randomUUID() })
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  async function restore() {
    if (state.kind !== "ready" || busy) return
    setBusy(true)
    try {
      await acp.rewind(state.sourceId, {
        id: state.operationId,
        requestId,
        position,
        expectedId: state.preview.current.id,
      })
      setOpen(false)
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  async function recover() {
    setBusy(true)
    try {
      await acp.recoverRewinds()
      await load()
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={!boundary}
        aria-disabled={boundary?.kind !== "ready"}
        title={
          boundary?.kind === "ready"
            ? `Review files before rewinding ${pointLabel}`
            : refused
              ? "Why this can't be rewound"
              : "The workspace checkpoint is still being saved"
        }
        className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground disabled:opacity-40 aria-disabled:opacity-40 aria-disabled:hover:opacity-70"
        onClick={() => {
          setOpen(true)
          if (!refused) void load()
        }}
      >
        <RotateCcwIcon className="size-3" /> Rewind
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <DialogContent className="space-y-4 p-5">
          <DialogTitle>
            {refused ? "No rewind for this answer" : `Rewind ${pointLabel}`}
          </DialogTitle>
          {refused !== undefined && (
            <div className="space-y-3 text-ui">
              <p>{refused}</p>
              <p className="text-muted-foreground">
                Rewind needs the workspace saved {pointLabel}. Mako still
                records who changed each line, so Changes and file links work
                as usual.
              </p>
            </div>
          )}
          {!refused && state.kind === "loading" && (
            <p className="text-ui text-muted-foreground">
              Checking the current workspace…
            </p>
          )}
          {!refused && state.kind === "error" && (
            <div className="space-y-3 text-ui">
              <p role="alert" className="text-destructive">
                {state.message}
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  className="pressable hover:underline"
                  onClick={() => void load()}
                >
                  Refresh preview
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="pressable hover:underline"
                  onClick={() => void recover()}
                >
                  Recover unfinished rewind
                </button>
              </div>
            </div>
          )}
          {!refused && state.kind === "ready" && (
            <div className="space-y-3 text-ui">
              <p>
                Restore {state.preview.changedFileCount}{" "}
                {state.preview.changedFileCount === 1 ? "file" : "files"} across
                this workspace to the state saved {pointLabel}.{" "}
                {state.preview.stagingChanged
                  ? "Staged changes will also be restored."
                  : "Staged changes already match."}
              </p>
              <p className="text-code font-mono break-all text-muted-foreground">
                {state.preview.target.scope}
              </p>
              <OthersWarning preview={state.preview} thread={thread} />
              {!!state.preview.changedFiles.length && (
                <ul className="text-code max-h-48 overflow-auto rounded border border-border p-3 font-mono">
                  {state.preview.changedFiles.map((path) => (
                    <li key={path} className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 break-all">{path}</span>
                      <WritersLabel
                        writers={state.preview.writers?.[path]}
                        thread={thread}
                      />
                    </li>
                  ))}
                  {state.preview.changedFileCount >
                    state.preview.changedFiles.length && (
                    <li className="mt-2 text-muted-foreground">
                      {state.preview.changedFileCount -
                        state.preview.changedFiles.length}{" "}
                      more files
                    </li>
                  )}
                </ul>
              )}
              <p className="text-muted-foreground">
                {state.preview.writers
                  ? "Every change made since this checkpoint will be replaced."
                  : "Changes made after this checkpoint, including your edits and other agents' edits, will be replaced."}{" "}
                A new idle conversation will open {pointLabel}. The original
                conversation stays available.
              </p>
              <p className="text-muted-foreground">
                Ignored files stay in place. Git commits and your branch stay
                where they are.
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2 text-ui">
            <button
              type="button"
              disabled={busy}
              className="pressable rounded px-3 py-1.5 hover:bg-foreground/5"
              onClick={() => setOpen(false)}
            >
              {refused ? "Close" : "Cancel"}
            </button>
            {!refused && <button
              type="button"
              disabled={state.kind !== "ready" || busy}
              className="pressable rounded bg-foreground px-3 py-1.5 text-background disabled:opacity-40"
              onClick={() => void restore()}
            >
              {busy ? "Restoring…" : "Restore files and rewind"}
            </button>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Whether a writer is someone other than this Thread, for sure or maybe. */
function other(writer: RewindWriter, thread: string | undefined): boolean {
  return writer.kind !== "thread" || writer.thread !== thread
}

/**
 * Said above the files when some of them hold work that isn't this Thread's:
 * a whole-workspace rewind takes that back too. Another turn running in the
 * checkout alongside this one says so even before the journal names a file.
 */
function OthersWarning({ preview, thread }: { preview: RewindPreview; thread: string | undefined }) {
  const files = preview.changedFiles.filter((path) => preview.writers?.[path]?.some((writer) => other(writer, thread))).length
  const shared = Boolean(preview.target.shared?.length || preview.current.shared?.length)
  if (!files && !shared) return null
  const more = preview.changedFileCount > preview.changedFiles.length
  return (
    <p role="note" className="text-caution">
      {files
        ? `${files}${more ? " or more" : ""} of these ${files === 1 ? "file has" : "files have"} changes by you or another thread since this checkpoint. Rewinding replaces them too.`
        : "Another thread worked in this checkout during this turn. Rewinding replaces its changes too."}
    </p>
  )
}

/** Who changed one file since the checkpoint, in a few words. */
function WritersLabel({ writers, thread }: { writers: RewindWriter[] | undefined; thread: string | undefined }) {
  const titles = useThreadTitles((state) => state.byThread)
  if (!writers?.length) return null
  const words = writers.map((writer) => {
    if (writer.kind === "person") return "You"
    if (writer.kind === "unknown") return "Unknown"
    const name = writer.thread === thread ? "This thread" : (titles[writer.thread]?.title ?? "Another thread")
    return writer.sure ? name : `${name}?`
  })
  const others = writers.some((writer) => other(writer, thread))
  return (
    <span
      className={`max-w-[45%] shrink-0 truncate text-right font-sans text-label ${others ? "text-caution" : "text-muted-foreground"}`}
      title={`${words.join(", ")}${writers.some((writer) => writer.kind === "thread" && !writer.sure) ? ". A ? means Mako isn't sure: that thread was only running when the file changed." : ""}`}
    >
      {words.join(", ")}
    </span>
  )
}

export function PromptRewindButton({ requestId }: { requestId?: string }) {
  return requestId ? (
    <RewindButton requestId={requestId} position="before" />
  ) : null
}
