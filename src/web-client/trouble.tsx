import { useState } from "react"
import { CheckIcon, CopyIcon, MinusIcon, RotateCwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { diagnosisText, type Diagnosis, type HopState } from "./diagnosis"

const HOP_WORDS = { ok: "Reached", failed: "Not reached", unknown: "Not checked" } satisfies Record<HopState, string>

/**
 * A diagnosis drawn: the headline and its line, the chain of hops each with how it stands, what it may be, and Try
 * again (Checking… while it checks) beside Copy diagnostics. `compact`: the headline and the actions only, the rest a
 * tap away, for a strip above a transcript.
 */
export function DiagnosisCard({ diagnosis, checking, onTryAgain, compact = false, className }: { diagnosis: Diagnosis; checking: boolean; onTryAgain: () => void; compact?: boolean; className?: string }) {
  const [open, setOpen] = useState(!compact)
  const copy = () =>
    void navigator.clipboard.writeText(diagnosisText(diagnosis)).then(
      () => toast.success("Copied", { description: "Diagnostics, with no secrets in them." }),
      () => toast.error("Not copied", { description: "This browser didn't allow it." })
    )
  return (
    <section className={cn("web-trouble", compact && "web-trouble-compact", className)} data-diagnosis={diagnosis.at} aria-live="polite">
      <button type="button" className="web-trouble-head" onClick={() => setOpen((shown) => !shown)} aria-expanded={open} disabled={!compact}>
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-ui font-semibold text-foreground" data-diagnosis-headline>
            {diagnosis.headline}
          </span>
          {diagnosis.detail ? <span className="mt-0.5 block text-label text-muted-foreground">{diagnosis.detail}</span> : null}
        </span>
        {compact ? <span className="shrink-0 text-label text-faint">{open ? "Less" : "Details"}</span> : null}
      </button>
      {open ? (
        <>
          <ol className="web-hops" aria-label="Where it stops">
            {diagnosis.hops.map((hop) => (
              <li key={hop.id} className="web-hop" data-hop={hop.id} data-state={hop.state}>
                <span className="web-hop-mark" aria-hidden>
                  {hop.state === "ok" ? <CheckIcon className="size-3" strokeWidth={3} /> : hop.state === "failed" ? <XIcon className="size-3" strokeWidth={3} /> : <MinusIcon className="size-3" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{hop.label}</span>
                <span className="shrink-0 text-faint">{HOP_WORDS[hop.state]}</span>
              </li>
            ))}
          </ol>
          {diagnosis.causes.length ? (
            <ul className="web-causes" aria-label="What it may be">
              {diagnosis.causes.map((cause) => (
                <li key={cause}>{cause}</li>
              ))}
            </ul>
          ) : null}
        </>
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
