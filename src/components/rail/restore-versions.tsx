import { useEffect, useState } from "react"
import { HistoryIcon } from "lucide-react"
import type { LostVersion } from "@mako/host/contracts/thread-changes"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { formatBytes, formatRelative } from "@/lib/format"
import { homeRelative } from "@/lib/skill-matrix"
import { lostVersions, restoreVersion } from "@/state/lost-versions"

/**
 * The last version of each file a Thread wrote that the disk no longer has,
 * kept for 14 days: after a `git checkout -- .`, a hard reset or a dropped
 * stash. One button each writes it back. Not a history browser.
 */
export function RestoreVersions({ thread, title, onClose }: { thread: string | undefined; title: string; onClose: () => void }) {
  const [versions, setVersions] = useState<LostVersion[]>()
  const [busy, setBusy] = useState<number>()
  useEffect(() => {
    if (!thread) return
    let current = true
    void lostVersions(thread).then((found) => { if (current) setVersions(found) })
    return () => { current = false }
  }, [thread])
  return (
    <Dialog open={Boolean(thread)} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="w-[calc(100vw-32px)] max-w-dialog overflow-hidden" data-restore-versions="">
        <div className="flex gap-2.5 px-5 pt-4.5">
          <HistoryIcon className="mt-1 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-title leading-6">Restore a version</DialogTitle>
            <p className="mt-0.5 text-ui leading-relaxed text-muted-foreground">
              Files “{title}” wrote whose last version isn&rsquo;t on disk any more. Mako keeps them for 14 days.
            </p>
          </div>
        </div>
        <ul className="mx-5 mt-3.5 mb-5 max-h-80 divide-y divide-hairline overflow-y-auto border border-hairline bg-foreground/[0.025]">
          {!versions ? <li className="flex h-8 items-center px-3 text-ui text-faint">Reading what Mako kept…</li> : null}
          {versions?.length === 0 ? <li className="flex h-8 items-center px-3 text-ui text-faint">Every version it wrote is on disk.</li> : null}
          {versions?.map((version) => (
            <li key={`${version.root}:${version.entry}`} className="flex h-9 items-center gap-2.5 px-3" data-lost-version={version.entry}>
              <span className="min-w-0 flex-1 truncate text-ui" title={version.path}>{homeRelative(version.path)}</span>
              <span className="shrink-0 text-label text-faint tabular-nums">
                {formatRelative(version.at)}{version.size === undefined ? "" : ` · ${formatBytes(version.size)}`}
              </span>
              <button
                type="button"
                disabled={busy !== undefined}
                onClick={() => {
                  setBusy(version.entry)
                  void restoreVersion(version).then((done) => {
                    setBusy(undefined)
                    if (done) setVersions((list) => list?.filter((item) => item !== version))
                  })
                }}
                className="pressable h-6 shrink-0 rounded-md px-2 text-label font-medium text-muted-foreground hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
              >
                {busy === version.entry ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
