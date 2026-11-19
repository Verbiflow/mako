import { finsWord, UNFINISHED_WORDS } from "@mako/host/contracts/agents"
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
      // Its Apex's to decide, so quiet, as the Shiver card's "Asking its Apex": the attention hue is for what waits on the person.
      return card.decides === "lead" ? { word: "finished · asks its Apex", tone: "text-muted-foreground" } : { word: "finished", tone: "text-positive" }
    case "failed":
      // Not a failure: its Apex sends it on or takes its reply, so quiet, as one its Apex decides.
      return card.unfinished ? { word: UNFINISHED_WORDS, tone: "text-muted-foreground" } : { word: "failed", tone: "text-negative" }
    case "progress":
      return { word: "says", tone: "text-faint" }
  }
}

/**
 * A report a turn's fold never hides: one that waits on the person, a failure or an end without a result, another
 * Apex that didn't reply, and a done Fin's decision while the roster still holds it open (`open`), whoever's it is.
 */
export function reportStays(card: FinReportCard, open: boolean): boolean {
  return said(card).tone === "text-attention" || card.status === "failed" || (card.apex === true && card.status !== "done") || open
}

/** Reports a fold holds, as its line says them: "Docs pass finished", "3 Fins finished", "5 Fins reported". */
export function reportsPhrase(cards: readonly FinReportCard[]): string {
  const replies = cards.every((card) => card.apex)
  const verb = replies ? "replied" : cards.every((card) => card.status === "done" || card.status === "failed") ? "finished" : "reported"
  if (cards.length === 1) return `${cards[0]!.name} ${verb}`
  return `${replies ? `${cards.length} Apexes` : finsWord(cards.length)} ${verb}`
}
