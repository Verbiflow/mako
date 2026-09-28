/** A row that asks for you, for the rail's announcer. */
export interface RailAsk {
  key: string
  title: string
  kind: "needs-permission" | "failed"
}

/** What the rail says when rows start asking for you, or nothing. */
export function railAnnouncement(previous: ReadonlyMap<string, RailAsk["kind"]>, asks: readonly RailAsk[]): string | undefined {
  const fresh = asks.filter((ask) => previous.get(ask.key) !== ask.kind)
  const [first] = fresh
  if (!first) return undefined
  if (fresh.length > 1) return `${fresh.length} threads need you`
  return `${first.title} ${first.kind === "failed" ? "failed" : "needs your approval"}`
}
