import { useCallback, useEffect, useState } from "react"
import { Action } from "@/components/ui/kit"
import { desktop } from "@/state/desktop"
import { diagnostics } from "@/state/diagnostics"
import { formatRelative } from "@/lib/format"
import type { CrashReport } from "../../../electron/crash.ts"
import type { ProviderResidencySnapshot } from "../../../electron/contracts/provider-residency.ts"

/**
 * What broke, and where it is written down.
 *
 * Crash reports are useless if nobody can find them, and a report you cannot
 * read is a report you cannot decide to send. This lists them, shows the stack,
 * and gives one button to copy the whole thing — which is what someone
 * actually needs when they want to tell you what happened.
 */
export function DiagnosticsSection() {
  const [crashes, setCrashes] = useState<CrashReport[]>([])
  const [dir, setDir] = useState("")
  const [hostLog, setHostLog] = useState("")
  const [residency, setResidency] =
    useState<ProviderResidencySnapshot | null>(null)
  const [openId, setOpenId] = useState<string>()

  const load = useCallback(() => {
    void diagnostics.list().then(setCrashes).catch(() => setCrashes([]))
    void diagnostics.directory().then(setDir).catch(() => setDir(""))
    void diagnostics.hostLogPath().then(setHostLog).catch(() => setHostLog(""))
    void diagnostics
      .providerResidency()
      .then(setResidency)
      .catch(() => setResidency(null))
  }, [])

  useEffect(load, [load])

  return (
    <div className="flex flex-col gap-1">
      <p className="pb-2 text-ui leading-relaxed text-muted-foreground">
        Written to this machine and nowhere else. Nothing here is sent anywhere
        — copy a report if you want to pass it on.
      </p>

      {crashes.length === 0 ? (
        <p className="rounded-lg bg-surface px-3 py-4 text-center text-ui text-faint ring-1 ring-hairline">
          Nothing has crashed. This stays empty unless something does.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {crashes.map((crash) => (
            <div
              key={crash.id}
              className="rounded-lg bg-surface ring-1 ring-hairline"
            >
              <button
                type="button"
                onClick={() =>
                  setOpenId(openId === crash.id ? undefined : crash.id)
                }
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="shrink-0 rounded bg-raised px-1.5 py-px text-label text-faint">
                  {crash.kind.replace("-", " ")}
                </span>
                <span className="min-w-0 flex-1 truncate text-ui">
                  {crash.message}
                </span>
                <span className="tabular shrink-0 text-label text-faint">
                  {formatRelative(crash.at)}
                </span>
              </button>
              {openId === crash.id ? (
                <div className="border-t border-hairline px-3 py-2">
                  <pre className="max-h-56 overflow-auto font-mono text-label leading-relaxed text-faint">
                    {crash.stack ?? "No stack was captured."}
                  </pre>
                  <div className="mt-2 flex items-center gap-2">
                    <Action
                      tone="outline"
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          JSON.stringify(crash, null, 2)
                        )
                      }
                    >
                      Copy the report
                    </Action>
                    <span className="text-label text-faint">
                      {crash.app.version} · Electron {crash.app.electron} ·{" "}
                      {crash.os.platform} {crash.os.arch}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {hostLog ? (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-surface px-3 py-2 ring-1 ring-hairline">
          <div className="min-w-0">
            <p className="text-ui">Host log</p>
            <p className="truncate text-label text-faint" title={hostLog}>
              Every provider start, startup step, failure and exit, one line
              each. Read it when a session says it did not start.
            </p>
          </div>
          <Action
            tone="ghost"
            onClick={() => void desktop.revealPath(hostLog)}
          >
            Show the log
          </Action>
        </div>
      ) : null}

      {residency ? (
        <div className="mt-2 rounded-lg bg-surface ring-1 ring-hairline">
          <div className="px-3 py-2">
            <p className="text-ui">Provider residency</p>
            <p className="text-label text-faint">
              {residency.active} active conversations · {residency.warm} warm
              resumable processes · {residency.protected} processes awaiting a
              resumable checkpoint · {residency.hibernated} hibernated
              conversations · {residency.disconnected} disconnected
              conversations
            </p>
            <p className="mt-1 text-label leading-relaxed text-faint">
              Mako keeps at most {residency.warmLimit} resumable idle processes
              for faster follow-ups and hibernates them after idle for{" "}
              {Math.round(residency.idleMs / 60_000)} minutes.
            </p>
          </div>
          {residency.entries.length > 0 ? (
            <div className="max-h-56 overflow-auto border-t border-hairline">
              {residency.entries.slice(0, 20).map((entry) => (
                <div
                  key={entry.conversationId}
                  className="flex items-center gap-3 border-b border-hairline px-3 py-1.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-label">
                    {entry.provider}: {entry.title}
                  </span>
                  <span className="shrink-0 text-label text-faint">
                    {entry.state}
                  </span>
                </div>
              ))}
              {residency.entries.length > 20 ? (
                <p className="px-3 py-1.5 text-label text-faint">
                  {residency.entries.length - 20} more conversations
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <Action tone="outline" onClick={load}>
          Refresh
        </Action>
        {dir ? (
          <Action tone="ghost" onClick={() => void desktop.revealPath(dir)}>
            Show the folder
          </Action>
        ) : null}
        {crashes.length > 0 ? (
          <Action
            tone="danger"
            onClick={() => {
              void diagnostics.clear().then(load)
            }}
          >
            Delete them all
          </Action>
        ) : null}
      </div>
    </div>
  )
}
