/**
 * How a conversation's live updates are written on their way to a reader. Each reader says the newest form it reads,
 * and a runtime writes an update in a newer form than the oldest one its readers read only where the gateway said every
 * one of them reads it:
 * - 1, whole: what an update changed, each value in full, with the line's route ahead of it. Every build reads it.
 * - 2, compact: what an update changed relative to the update before it, which an older reader would misread as whole
 *   (`COMPACT_LIVE_FORM`); its line is the update alone, read by its own first characters.
 *
 * A client says the form it reads when it connects (`LIVE_FORM_PARAM` on its connection's URL), for every subscription
 * of that connection; one that says nothing reads form 1. From link version 13 (`COMPACT_LIVE_VERSION`), the gateway
 * tells a runtime the form every current reader of each of its watched conversations reads (`watch`'s `forms`) and of
 * each Thread it runs (`live-form`), again each time that changes; the runtime marks an update it writes in a form above
 * 1 (`live`'s and `event`'s `form`), and the gateway gives a reader of an older form the notice to read the conversation
 * again in its place (`streamNotice: "reread"`). So a reader never sees a form it doesn't read, and a reader that comes or
 * goes changes what's written from the runtime's next update on, with nothing missed or applied twice between.
 *
 * Imports no code, so a window's preload reads it without bundling zod.
 */
export type LiveForm = 1 | 2

export const WHOLE_LIVE_FORM = 1 satisfies LiveForm
export const COMPACT_LIVE_FORM = 2 satisfies LiveForm

/** The newest form this build reads and writes. */
export const LIVE_FORM: LiveForm = COMPACT_LIVE_FORM

/** The query parameter a client's connection says the form it reads in. */
export const LIVE_FORM_PARAM = "live"

/** The form a reader says it reads, as text (a URL's parameter, a header): form 1 when it says none, the newest this build knows for a newer one. */
export function saidLiveForm(said: string | null | undefined): LiveForm {
  const form = Number(said)
  return said && Number.isInteger(form) && form >= COMPACT_LIVE_FORM ? COMPACT_LIVE_FORM : WHOLE_LIVE_FORM
}

/** The form a connection's URL says its client reads (`saidLiveForm`). */
export function declaredLiveForm(url: URL): LiveForm {
  return saidLiveForm(url.searchParams.get(LIVE_FORM_PARAM))
}

/** A client connection's path, saying it reads `form`. */
export function readingLiveForm(path: string, form: LiveForm = LIVE_FORM): string {
  return form === WHOLE_LIVE_FORM ? path : `${path}${path.includes("?") ? "&" : "?"}${LIVE_FORM_PARAM}=${form}`
}

/** The form every reader of a stream reads, with how many read it and how many of them read only form 1 (`whole`). */
export type ReadersForm = { form: LiveForm; readers: number; whole: number }

/** The form every one of `readers` reads, and why, for the logs that say it. Form 1 for none, since a reader who comes later may read no other. */
export function readersForm(readers: Iterable<LiveForm>): ReadersForm {
  let common: LiveForm | undefined
  let count = 0
  let whole = 0
  for (const form of readers) {
    count += 1
    if (form === WHOLE_LIVE_FORM) whole += 1
    if (common === undefined || form < common) common = form
  }
  return { form: common ?? WHOLE_LIVE_FORM, readers: count, whole }
}

/** Whether a reader of `reads` reads an update written in `form` (absent: form 1). */
export function readsLiveForm(reads: LiveForm, form: LiveForm | undefined): boolean {
  return (form ?? WHOLE_LIVE_FORM) <= reads
}
