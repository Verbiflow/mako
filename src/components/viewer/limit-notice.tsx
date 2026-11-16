import { useEffect, useRef, useState } from "react"
import { answerFin, continueNext, nextPlace, type PersonAsk } from "@/state/fin-asks"
import { spentUntil } from "@mako/host/contracts/account-usage"
import { useAccounts } from "@/state/accounts"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"

/** Pending work offers recovery, never acknowledgement. An informational notice may still be dismissed. */
export function LimitNoticeRow({ apex, ask, compact }: { apex: string; ask: PersonAsk; compact: boolean }) {
  const [found, setFound] = useState<{ key: string; next: Awaited<ReturnType<typeof nextPlace>> }>()
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const request = useRef<string | undefined>(undefined)
  const accounts = useAccounts(state => JSON.stringify(state.accounts))
  const room = useAccounts(state => Object.entries(state.usage).map(([name, usage]) => {
    const full = spentUntil(usage, Date.now())
    return `${name}:${usage.status}:${full ? "full" : "room"}`
  }).sort().join("|"))
  const waiting = ask.limit?.waiting
  const active = waiting !== undefined
  const notice = ask.ask.id
  const key = `${notice}:${waiting?.version ?? ""}:${waiting?.count}:${waiting?.at}:${waiting?.resets}:${accounts}:${room}:${refresh}`
  const next = found?.key === key ? found.next : undefined
  useEffect(() => {
    if (!active) return
    let current = true
    void nextPlace(apex, notice).then(value => { if (current) setFound({ key, next: value }) })
    return () => { current = false }
  }, [apex, notice, active, key])
  const go = async () => {
    if (busy) return
    setBusy(true)
    if (waiting) {
      if (next?.choice) {
        request.current ??= crypto.randomUUID()
        if (await continueNext(apex, next.choice, request.current)) request.current = undefined
        setRefresh(value => value + 1)
      }
    } else await answerFin(apex, ask, { option: 0 })
    setBusy(false)
  }
  const time = waiting && new Date(waiting.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return (
    <div data-limit-notice={ask.ask.id} aria-busy={busy || undefined}
      className="mb-1.5 bg-[color-mix(in_oklab,var(--attention)_8%,var(--raised))] px-3 py-2.5 shadow-[inset_2px_0_0_var(--attention)]">
      <p className="text-ui text-foreground/90">{waiting ? `${waiting.count === 1 ? "1 Fin is" : `${waiting.count} Fins are`} waiting for ${harnessLabel(ask.harness)}.` : ask.question}</p>
      {waiting ? <p data-limit-auto={waiting.at} className="mt-1 text-label text-muted-foreground">
        {waiting.resets ? `Resets at ${time}. ${waiting.count === 1 ? "The Fin goes" : "The Fins go"} on by ${waiting.count === 1 ? "itself" : "themselves"}.` : `Next try at ${time}, automatically.`}
      </p> : null}
      {(!waiting || next?.choice) ? <button type="button" data-limit-seen={!waiting || undefined} data-limit-use={waiting ? next?.harness : undefined}
        disabled={busy} onClick={() => { void go() }}
        className={cn("pressable mt-2 flex items-center bg-foreground px-2.5 text-label font-medium text-background hover:bg-foreground/90 disabled:opacity-50", compact ? "h-9" : "h-7")}>
        {waiting ? `Use ${next!.label} now` : ask.ask.options?.[0]?.label ?? "Got it"}
      </button> : null}
    </div>
  )
}
