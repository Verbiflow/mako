import { useEffect, useRef } from "react"
import {
  ArrowUpRightIcon,
  Clock3Icon,
  ShieldCheckIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action, IconAction } from "@/components/ui/kit"
import { MakoMark } from "@/components/ui/mako-mark"
import { Notice, NoticeAction } from "@/components/ui/notice"
import { application, useApplication } from "@/state/application"
import type { LifecycleWork } from "../../../electron/shared"

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
  const quitting = action === "quit"
  const installing = action === "install"
  const work = lifecycle?.work ?? []
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
          <div className="flex size-11 items-center justify-center rounded-xl bg-raised ring-1 ring-hairline">
            <MakoMark className="size-7 text-foreground" />
          </div>
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
              : work.length
                ? `${work.length} ${work.length === 1 ? "operation is" : "operations are"} still active. ${quitting ? "Close the window without stopping their work." : "Your update can wait. No need to interrupt their work."}`
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
              {work.slice(0, 100).map((item) => (
                <li
                  key={item.id}
                  className="contain-turn flex items-center gap-3 border-b border-hairline py-3 last:border-0"
                >
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-foreground/45"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui" title={item.title}>
                      {item.title}
                    </p>
                    <p
                      className="mt-0.5 truncate text-label text-faint"
                      title={item.cwd}
                    >
                      {[
                        item.provider,
                        item.cwd.split("/").filter(Boolean).at(-1),
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Mako"}
                    </p>
                  </div>
                  <span className="shrink-0 text-label text-muted-foreground">
                    {statusLabels[item.status]}
                  </span>
                </li>
              ))}
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
              ? "Agents kept running will need Mako's host and this computer to stay on. Reopen Mako to pick up where you left off."
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
              if (quitting) void application.keepRunning()
              else if (action) void application.wait(action)
            }}
          >
            {quitting ? <ArrowUpRightIcon /> : <Clock3Icon />}
            {locked ? "Preparing safely…" : primary}
          </Action>
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
