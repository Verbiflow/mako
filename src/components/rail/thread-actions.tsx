import { useState } from "react"
import { toast } from "sonner"
import { DropdownMenu } from "radix-ui"
import { ArchiveIcon, ArchiveRestoreIcon, ClipboardCopyIcon, ClipboardListIcon, MoreHorizontalIcon, SquareIcon } from "lucide-react"
import { threadLifecycle, type ThreadControls, type ThreadTarget } from "@/state/thread-lifecycle"

export function ThreadActions({ target, title, archived, running, controlled, path }: { target: ThreadTarget; title: string; archived: boolean; running: boolean; controlled: boolean; path?: string }) {
  const [busy, setBusy] = useState(false)
  const [controls, setControls] = useState<ThreadControls | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stop = async () => {
    if (busy) return
    setBusy(true)
    try {
      const latest = controls ?? await threadLifecycle.controls(target)
      if (latest.stop) await threadLifecycle.stop(latest.stop)
      else toast(latest.external ? "This run is controlled by another app" : "There is no running task to stop")
    } catch (error) { toast.error("The run could not be stopped", { description: error instanceof Error ? error.message : "Controls are unavailable" }) }
    finally { setBusy(false) }
  }
  return (
    <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {running && controlled ? <button type="button" aria-label={`Stop ${title}`} title="Stop this run and pause its queue" disabled={busy} onClick={() => { void stop() }} className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"><SquareIcon className="size-2.5 fill-current" strokeWidth={0} /></button> : null}
      <DropdownMenu.Root modal={false} onOpenChange={(open) => {
        if (!open) { setControls(null); return }
        setError(null)
        void threadLifecycle.controls(target).then(setControls).catch((error) => setError(error instanceof Error ? error.message : "Controls are unavailable"))
      }}>
        <DropdownMenu.Trigger asChild><button type="button" aria-label={`Actions for ${title}`} className="pressable flex size-6 shrink-0 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"><MoreHorizontalIcon className="size-3.5" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className="overlay-panel z-50 min-w-48 rounded-lg p-1 text-ui">
          <DropdownMenu.Item disabled={busy || !controls?.stop} onSelect={() => { void stop() }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover data-[disabled]:text-faint"><SquareIcon className="size-3" />{controls?.external ? "Controlled by another app" : "Stop run and pause queue"}</DropdownMenu.Item>
          <DropdownMenu.Item data-thread-action="archive" onSelect={() => { void threadLifecycle.archive(target, !archived) }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover">{archived ? <ArchiveRestoreIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}{archived ? "Restore thread" : running ? "Archive when finished" : "Archive thread"}</DropdownMenu.Item>
          {path ? <>
            <DropdownMenu.Item onSelect={() => { void threadLifecycle.copyTranscript(path, "concise") }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"><ClipboardListIcon className="size-3.5" />Copy concise transcript</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => { void threadLifecycle.copyTranscript(path, "full") }} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-fill-hover"><ClipboardCopyIcon className="size-3.5" />Copy full transcript</DropdownMenu.Item>
          </> : null}
          {error ? <p role="alert" className="max-w-64 px-2 py-1 text-label text-negative">{error}</p> : null}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  )
}
