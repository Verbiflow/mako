import type { ChatMessage } from "@/lib/types"

/**
 * Where each marker and provider-started turn a drawing holds came from:
 * the native record it cites, whether it was built from the live wire with
 * no record to read, and where its body was read. `npm run decode --
 * --events` prints it for a capture, a store or a pair, so a body that is
 * missing or wrong can be traced to its line and its file without reading
 * the session by hand.
 */
export interface EventProvenance {
  label: string
  opensTurn: boolean
  /** The native record the line cites, if any. */
  record?: string
  /** `store`: read from the harness's own record; `wire`: what the live wire said, when no record could be read; `uncited`: neither says. */
  via: "store" | "wire" | "uncited"
  /** `record`: the record holds it; a file's name when a command's output was read from one; `none`: nothing opens. */
  body: "record" | "output-file" | "kept-copy" | "none"
  bodyChars: number
}

export function eventProvenance(messages: readonly ChatMessage[]): EventProvenance[] {
  return messages.flatMap((message) => {
    const note = message.note
    if (!note) return []
    const source = note.source
    const row: EventProvenance = {
      label: note.label,
      opensTurn: message.opensTurn === true,
      via: source?.via ?? (source ? "store" : "uncited"),
      body: note.body ? source?.body ?? "record" : "none",
      bodyChars: note.body?.length ?? 0,
    }
    if (source) row.record = source.record
    return [row]
  })
}

/** One line each: what opened or was marked, the record it cites, and where its body came from. */
export function provenanceLines(rows: readonly EventProvenance[]): string[] {
  return rows.map((row) => {
    const what = `${row.opensTurn ? "turn  " : "marker"} ${row.label.length > 72 ? `${row.label.slice(0, 71)}…` : row.label}`
    const cites = row.record ? `record ${row.record}` : "no record"
    const body = row.body === "none" ? "no body" : `body from ${row.body} (${row.bodyChars} chars)`
    return `${what}\n         ${cites} · via ${row.via} · ${body}`
  })
}
