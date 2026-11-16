import { useLimitContinue, type LimitContinue } from "@/state/limit-continue"
import { clockText } from "@/state/request-recovery"

/** The same reset wait as the desk, in the phone's dock; moving remains the person's choice. */
export function LimitContinueCard() {
  const offer = useLimitContinue()
  return offer ? <LimitContinueLine offer={offer} /> : null
}

export function LimitContinueLine({ offer }: { offer: LimitContinue }) {
  return (
    <div className="mx-auto flex w-full max-w-content items-center gap-2 px-4 py-1 text-label text-faint" data-usage-limit-wait={offer.at} data-limit-continue={offer.to} aria-busy={offer.busy || undefined}>
      <span>{offer.resets ? "Sends" : "Tries again"} at {clockText(offer.at)}</span>
      {offer.to ? <>
        <span aria-hidden>·</span>
        <button type="button" className="web-quiet-button" disabled={offer.busy} onClick={offer.go}>Use {offer.to} now</button>
      </> : null}
    </div>
  )
}
