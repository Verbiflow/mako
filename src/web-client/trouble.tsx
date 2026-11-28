import { useState } from "react"
import { CopyIcon, RotateCwIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useExit } from "@/components/ui/exit-motion"
import type { Diagnosis } from "./diagnosis"
import { copyDiagnostics } from "./trouble-state"

/**
 * A diagnosis drawn: the headline and its line (with a spinner while Mako retries by itself), what it may be, and Try
 * again (Checking… while it checks) beside Copy diagnostics. The chain of hops and the raw reason are in what Copy
 * diagnostics copies, never on the card. `compact`: the headline and the actions only, the causes a tap away, for a
 * strip above a transcript.
 */
export function DiagnosisCard({ diagnosis, checking, onTryAgain, compact = false, className }: { diagnosis: Diagnosis; checking: boolean; onTryAgain: () => void; compact?: boolean; className?: string }) {
  const [open, setOpen] = useState(!compact)
  const copy = () => copyDiagnostics(diagnosis)
  // Once it's reached again, the card leaves and what's under it comes up into its room (`exit.tsx`).
  const exit = useExit<HTMLElement>(`trouble:${className ?? "card"}`)
  return (
    <section ref={exit} className={cn("web-trouble", compact && "web-trouble-compact", className)} data-diagnosis={diagnosis.at} aria-live="polite">
      <button type="button" className="web-trouble-head" onClick={() => setOpen((shown) => !shown)} aria-expanded={open} disabled={!compact}>
        {diagnosis.retrying ? <Spinner aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-ui font-semibold text-foreground" data-diagnosis-headline data-retrying={diagnosis.retrying || undefined}>
            {diagnosis.headline}
          </span>
          {diagnosis.detail ? <span className="mt-0.5 block text-label text-muted-foreground">{diagnosis.detail}</span> : null}
        </span>
        {compact && diagnosis.causes.length ? <span className="shrink-0 text-label text-faint">{open ? "Less" : "Details"}</span> : null}
      </button>
      {open && diagnosis.causes.length ? (
        <ul className="web-causes" aria-label="What it may be">
          {diagnosis.causes.map((cause) => (
            <li key={cause}>{cause}</li>
          ))}
        </ul>
      ) : null}
      <div className="web-trouble-actions">
        <button type="button" className="web-button" onClick={onTryAgain} disabled={checking} data-checking={checking || undefined}>
          {checking ? <Spinner className="size-4" /> : <RotateCwIcon className="size-4" />}
          {checking ? "Checking…" : "Try again"}
        </button>
        <button type="button" className="web-quiet-button" onClick={copy}>
          <CopyIcon className="size-4" />
          Copy diagnostics
        </button>
      </div>
    </section>
  )
}
