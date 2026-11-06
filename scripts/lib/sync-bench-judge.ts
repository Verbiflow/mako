/** `count`: work done, which a busy machine doesn't change. `time`: what a runner's noise can move. */
export type Check = { name: string; kind: "count" | "time"; value: number | null; limit: number; ok: boolean; again?: number | null }

/**
 * What fails a sync bench that ran `first` and, when a time was over, `again` as a second whole run. A count fails in
 * whichever run it's over, and a time only gets a second try: the bench passes on a run that met every budget, whole,
 * never on what two runs met between them. So once a second run is over anything, or left a check unmeasured, both
 * runs failed and all each had over is reported. Each check of `first` that the second run read carries its value.
 */
export function failures(first: Check[], again?: Check[]): Check[] {
  if (!again) return first.filter((item) => !item.ok)
  const second = new Map(again.map((item) => [item.name, item]))
  for (const item of first) if (second.has(item.name)) item.again = second.get(item.name)!.value
  const unmeasured = first.filter((item) => !second.has(item.name))
  const overAgain = [...unmeasured, ...again.filter((item) => !item.ok)]
  if (!overAgain.length) return first.filter((item) => !item.ok && item.kind === "count")
  const named = new Set(overAgain.map((item) => item.name))
  const failed = first.filter((item) => !item.ok || named.has(item.name))
  return [...failed, ...overAgain.filter((item) => !first.some((other) => other.name === item.name))]
}
