import { useEffect, useRef, useState } from "react"
import {
  ArrowUpRightIcon,
  CheckIcon,
  Clock3Icon,
  CloudIcon,
  CloudUploadIcon,
  ShieldCheckIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action, IconAction, Toggle } from "@/components/ui/kit"
import { MakoTile } from "@/components/ui/mako-mark"
import { Notice, NoticeAction } from "@/components/ui/notice"
import { application, useApplication } from "@/state/application"
import { useCloudMoves } from "@/state/cloud-moves"
import { useHandOff } from "@/state/handoff"
import type { LifecycleWork } from "@mako/host/contracts/app-lifecycle"
import type { HandOffCandidate, HandOffResult, ThreadMoveStep } from "@mako/host/contracts/cloud-threads"

/** A Thread's handoff as its row says it, step by step. */
function stepLabel(step: ThreadMoveStep): string | undefined {
  switch (step.kind) {
    case "packing":
      return "Sending ahead"
    case "pausing":
      return "Pausing its turn"
    case "handing-over":
      return "Handing over"
    case "resuming":
      return "Starting in the cloud"
    default:
      return undefined
  }
}

/** Where one working item stands in a handoff: on its way (the move's step), in the cloud, or here, saying why. */
function handOffState(
  item: LifecycleWork,
  candidate: HandOffCandidate | undefined,
  step: ThreadMoveStep | undefined,
  result: HandOffResult | undefined
): { label: string; done?: boolean; reason?: string } | undefined {
  if (!candidate || candidate.refusal) return undefined
  if (result) {
    if (result.outcome.kind === "moved") return { label: "In the cloud", done: true }
    // This Mac let go of it; its host starts it in the cloud after the window closes.
    if (result.outcome.kind === "released") return { label: "Handed to the cloud", done: true }
    return { label: "Stayed here", reason: result.outcome.reason }
  }
  const label = step && stepLabel(step)
  if (label) return { label }
  return item.status === "running" ? { label: "Waiting to go" } : undefined
}

const statusLabels = {
  running: "Working",
  waiting: "Needs your input",
  queued: "Queued",
  finishing: "Finishing up",
} satisfies Record<LifecycleWork["status"], string>

export function ApplicationDialog() {
  const action = useApplication((state) => state.dialog)
  const lifecycle = useApplication((state) => state.lifecycle)
  const busy = useApplication((state) => state.busy)
  const error = useApplication((state) => state.error)
  const safeAction = useRef<HTMLButtonElement>(null)
  const candidates = useHandOff((state) => state.candidates)
  const running = useHandOff((state) => state.running)
  const moving = useCloudMoves((state) => state.moving)
  const [remember, setRemember] = useState(false)
  const quitting = action === "quit"
  const installing = action === "install"
  const work = lifecycle?.work ?? []
  const byConversation = new Map((candidates ?? []).map((candidate) => [candidate.conversationId, candidate]))
  const results = new Map((running?.results ?? []).map((result) => [result.conversationId, result]))
  // The cloud is on and at least one Thread at work can go: the sheet offers to hand them over.
  const canHandOff = quitting && (candidates ?? []).some((candidate) => !candidate.refusal)
  const handingOff = quitting && running !== null && !running.results
  const stayed = [...results.values()].filter((result) => result.outcome.kind !== "moved" && result.outcome.kind !== "released")
  const locked =
    busy ||
    (!error &&
      (lifecycle?.operation.kind === "applying" ||
        lifecycle?.operation.kind === "stopping"))
  const title = quitting
    ? "Quit Mako?"
    : installing
      ? "Install your update?"
      : "Restart Mako?"
  const primary = quitting
    ? "Quit and keep agents running"
    : installing
      ? "Install when agents finish"
      : "Restart when agents finish"
  const destructive = quitting
    ? "Stop agents and quit"
    : installing
      ? "Stop agents and install"
      : "Stop agents and restart"

  useEffect(() => {
    if (
      action &&
      !locked &&
      (document.activeElement === document.body ||
        document.activeElement?.classList.contains("application-dialog"))
    )
      safeAction.current?.focus()
  }, [action, locked])

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) application.dismiss()
      }}
    >
      <DialogContent
        className="application-dialog overflow-hidden"
        aria-describedby="application-exit-description"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          safeAction.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (locked) event.preventDefault()
        }}
      >
        <div className="flex items-start justify-between px-6 pt-6">
          <MakoTile className="size-11" />
          <IconAction
            label={quitting ? "Cancel quitting" : "Not now"}
            disabled={locked}
            onClick={application.dismiss}
          >
            <XIcon />
          </IconAction>
        </div>
        <div className="px-6 pt-4 pb-5">
          <DialogTitle className="text-title">{title}</DialogTitle>
          <p
            id="application-exit-description"
            className="mt-2 text-ui leading-relaxed text-muted-foreground"
          >
            {!lifecycle
              ? "Checking the agent host before making any changes."
              : handingOff
                ? "Each agent's turn is paused, its Thread moves to a cloud machine, and the turn goes on there."
                : stayed.length
                  ? `${results.size - stayed.length} went to the cloud. ${stayed.length === 1 ? "One stayed" : `${stayed.length} stayed`} on this Mac, still working: keep ${stayed.length === 1 ? "it" : "them"} running here, or stop ${stayed.length === 1 ? "it" : "them"}.`
                  : work.length
                    ? `${work.length} ${work.length === 1 ? "operation is" : "operations are"} still active. ${quitting ? (canHandOff ? `Keep ${work.length === 1 ? "it" : "them"} working on this Mac, or hand ${work.length === 1 ? "it" : "them"} to the cloud so ${work.length === 1 ? "it goes" : "they go"} on while it's off.` : `Close the window without stopping ${work.length === 1 ? "its" : "their"} work.`) : `Your update can wait. No need to interrupt ${work.length === 1 ? "its" : "their"} work.`}`
                    : "No agents are working. Your saved conversations will be here when you return."}
          </p>
        </div>
        {work.length > 0 && (
          <div className="mx-6 overflow-hidden rounded-lg border border-hairline bg-surface">
            <div className="flex items-center justify-between border-b border-hairline px-3 py-2 text-label text-faint">
              <span>Across all Mako windows</span>
              <span>{work.length} active</span>
            </div>
            <ul className="max-h-48 overflow-y-auto overscroll-contain px-3">
              {work.slice(0, 100).map((item) => {
                const candidate = byConversation.get(item.id)
                const handing = running ? handOffState(item, candidate, moving[item.id]?.step, results.get(item.id)) : undefined
                const refusal = quitting && candidate?.refusal
                return (
                  <li
                    key={item.id}
                    data-handoff={handing ? (handing.done ? "moved" : handing.reason ? "stayed" : "going") : candidate && !candidate.refusal ? "can" : undefined}
                    className="contain-turn flex items-center gap-3 border-b border-hairline py-3 last:border-0"
                  >
                    {canHandOff && candidate && !candidate.refusal ? (
                      <CloudIcon className="size-3.5 shrink-0 text-faint" aria-label="Can go to the cloud" />
                    ) : (
                      <span
                        className="mx-1 size-1.5 shrink-0 rounded-full bg-foreground/45"
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ui" title={item.title}>
                        {item.title}
                      </p>
                      <p
                        className="mt-0.5 truncate text-label text-faint"
                        title={handing?.reason ?? (refusal || item.cwd)}
                      >
                        {handing?.reason ??
                          (canHandOff && refusal
                            ? `Stays here: ${refusal}`
                            : [
                                item.provider,
                                item.cwd.split("/").filter(Boolean).at(-1),
                              ]
                                .filter(Boolean)
                                .join(" · ") || "Mako")}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
                      {handing?.done ? <CheckIcon className="size-3.5" /> : null}
                      {handing?.label ?? statusLabels[item.status]}
                    </span>
                  </li>
                )
              })}
              {work.length > 100 && (
                <li className="py-2 text-label text-faint">
                  And {work.length - 100} more active operations. This choice
                  applies to all of them.
                </li>
              )}
            </ul>
          </div>
        )}
        <div className="flex items-start gap-2 px-6 py-4 text-label leading-relaxed text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
          <p>
            {quitting
              ? canHandOff
                ? "Agents kept running here need this computer to stay on. Handed to the cloud, they go on while it's off; bring a Thread back from its Cloud chip."
                : "Agents kept running will need Mako's host and this computer to stay on. Reopen Mako to pick up where you left off."
              : "Installation closes all Mako windows and replaces the agent host. Conversations are kept; stopped work is not automatically resumed."}
          </p>
        </div>
        {error && (
          <p
            role="alert"
            className="mx-6 mb-4 rounded-md bg-negative/10 p-3 text-ui text-negative"
          >
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 border-t border-hairline bg-surface p-4">
          <Action
            ref={safeAction}
            tone="solid"
            size="md"
            className="h-10 w-full"
            disabled={locked || (!quitting && !lifecycle)}
            onClick={() => {
              if (quitting) void application.keepRunning(remember)
              else if (action) void application.wait(action)
            }}
          >
            {quitting ? <ArrowUpRightIcon /> : <Clock3Icon />}
            {locked && !handingOff ? "Preparing safely…" : stayed.length ? `Quit and keep ${stayed.length === 1 ? "it" : "them"} running here` : primary}
          </Action>
          {canHandOff && !stayed.length && (
            <Action
              size="md"
              className="h-10 w-full"
              data-handoff-action
              disabled={locked}
              onClick={() => void application.handOffAndQuit(remember)}
            >
              <CloudUploadIcon />
              {handingOff ? "Handing off to the cloud…" : "Hand off to the cloud and quit"}
            </Action>
          )}
          {quitting && !stayed.length && (
            <label className="flex items-center justify-between gap-3 px-1 py-1 text-label text-muted-foreground">
              <span>Do this every time I quit while agents work</span>
              <Toggle label="Do this every time I quit while agents work" on={remember} disabled={locked} onChange={() => setRemember((value) => !value)} />
            </label>
          )}
          <div className="flex items-center justify-between gap-2">
            <Action size="md" disabled={locked} onClick={application.dismiss}>
              {quitting ? "Cancel" : "Not now"}
            </Action>
            <Action
              tone="danger"
              size="md"
              disabled={
                locked || !lifecycle || work.some((item) => !item.stoppable)
              }
              onClick={() => {
                if (action && lifecycle)
                  void application.stop(action, lifecycle.revision)
              }}
            >
              <SquareIcon />
              {destructive}
            </Action>
          </div>
          {work.some((item) => !item.stoppable) && (
            <p className="px-1 text-label leading-relaxed text-faint">
              A build, provider startup, or workspace operation must finish
              before Mako can stop safely.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ApplicationNotice() {
  const lifecycle = useApplication((state) => state.lifecycle)
  const busy = useApplication((state) => state.busy)
  if (!lifecycle || lifecycle.operation.kind === "idle") return null
  const { operation, work } = lifecycle
  const label =
    operation.action === "install"
      ? "Update"
      : operation.action === "restart"
        ? "Restart"
        : "Quit"
  return (
    <Notice
      tone={operation.kind === "error" ? "danger" : operation.kind === "waiting" ? "info" : "progress"}
      title={
        operation.kind === "waiting"
          ? `${label} will begin when ${work.length ? "active work finishes" : "Mako is ready"}`
          : operation.kind === "error"
            ? operation.message
            : `${label} in progress`
      }
      description={
        operation.kind === "waiting"
          ? "You can keep working."
          : operation.kind === "error"
            ? undefined
            : "Saving conversations and closing safely…"
      }
      className="mx-3 my-2"
      actions={
        operation.kind === "waiting" || operation.kind === "error" ? (
          <NoticeAction disabled={busy} onClick={() => void application.cancel()}>
            {operation.kind === "waiting" ? `Cancel ${label.toLowerCase()}` : "Dismiss"}
          </NoticeAction>
        ) : null
      }
    />
  )
}
