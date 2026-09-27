import { useState } from "react"
import { RotateCcwIcon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { acp, useAcp } from "@/state/acp"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
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
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PreviewState>({ kind: "loading" })
  const [busy, setBusy] = useState(false)
  if (!snapshots) return null
  const boundary = snapshots[position]
  const pointLabel =
    position === "before" ? "before this prompt" : "after this answer"
  const reason =
    boundary?.kind === "unavailable"
      ? boundary.reason
      : "The workspace checkpoint is still being saved"
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
        disabled={boundary?.kind !== "ready"}
        title={
          boundary?.kind === "ready"
            ? `Review files before rewinding ${pointLabel}`
            : reason
        }
        className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground disabled:opacity-40"
        onClick={() => {
          setOpen(true)
          void load()
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
          <DialogTitle>Rewind {pointLabel}</DialogTitle>
          {state.kind === "loading" && (
            <p className="text-ui text-muted-foreground">
              Checking the current workspace…
            </p>
          )}
          {state.kind === "error" && (
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
          {state.kind === "ready" && (
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
              {!!state.preview.changedFiles.length && (
                <ul className="text-code max-h-48 overflow-auto rounded border border-border p-3 font-mono">
                  {state.preview.changedFiles.map((path) => (
                    <li key={path} className="break-all">
                      {path}
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
                Changes made after this checkpoint, including your edits and
                other agents' edits, will be replaced. A new idle conversation
                will open {pointLabel}. The original conversation stays
                available.
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
              Cancel
            </button>
            <button
              type="button"
              disabled={state.kind !== "ready" || busy}
              className="pressable rounded bg-foreground px-3 py-1.5 text-background disabled:opacity-40"
              onClick={() => void restore()}
            >
              {busy ? "Restoring…" : "Restore files and rewind"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function PromptRewindButton({ requestId }: { requestId?: string }) {
  return requestId ? (
    <RewindButton requestId={requestId} position="before" />
  ) : null
}
