import type { FinReportCard } from "@mako/host/contracts/fin-reports"

/** What a report says it did: its word and the hue it's drawn in. */
export interface Said {
  word: string
  tone: string
}

/** What it did, in one word, as its report message labels it: what waits on the person in the attention hue, an end in its own. */
export function said(card: FinReportCard): Said {
  if (card.apex) return card.status === "done" ? { word: "replied", tone: "text-faint" } : { word: "didn't reply", tone: "text-negative" }
  switch (card.status) {
    case "needs-input":
      return { word: card.forPerson ? "asks you" : "asks", tone: "text-attention" }
    case "blocked":
      return { word: card.forPerson ? "waits on you" : "is blocked", tone: "text-attention" }
    case "done":
      if (card.decides === "person") return { word: "finished · needs you", tone: "text-attention" }
      // Its Apex's to decide, so quiet, as the crew card's "Asking its Apex": the attention hue is for what waits on the person.
      return card.decides === "lead" ? { word: "finished · asks its Apex", tone: "text-muted-foreground" } : { word: "finished", tone: "text-positive" }
    case "failed":
      return { word: "failed", tone: "text-negative" }
    case "progress":
      return { word: "says", tone: "text-faint" }
  }
}
