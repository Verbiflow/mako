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

/** Whether a report is a question for the person, as its word says it (`said`). */
export function asksPerson(card: FinReportCard): boolean {
  return said(card).tone === "text-attention"
}

/**
 * A question for the person as its line reads once the roster no longer holds it: a finished Fin's decision is a
 * finished Fin again, and any other was asked. Never "answered": a Fin that was stopped, or whose Apex answered
 * for the person, leaves the roster the same way.
 */
export function asked(card: FinReportCard): Said {
  return card.status === "done" ? { word: "finished", tone: "text-positive" } : { word: "asked you", tone: "text-faint" }
}

/** What each of a run's phrases counts, in the order the line says them: what needs the person first, then what went wrong. */
const RUN_WORDS = [
  ["needs", "needs you", "need you"],
  ["failed", "failed", "failed"],
  ["unfinished", UNFINISHED_WORDS, UNFINISHED_WORDS],
  ["asked", "asked", "asked"],
  ["finished", "finished", "finished"],
  ["reported", "reported", "reported"],
  ["replied", "replied", "replied"],
  ["silent", "didn't reply", "didn't reply"],
] as const

type RunWord = (typeof RUN_WORDS)[number][0]

function runWord(card: FinReportCard, waits: boolean): RunWord {
  if (card.apex) return card.status === "done" ? "replied" : "silent"
  if (waits) return "needs"
  if (card.status === "failed") return card.unfinished ? "unfinished" : "failed"
  if (card.status === "done") return "finished"
  return card.status === "progress" ? "reported" : "asked"
}

/**
 * A run of reports as its one line counts them, each Fin once a phrase: "1 Fin needs you · 1 failed · 4 finished".
 * The first phrase carries the noun for them all. `waits` says which questions for the person the roster still
 * holds open; one it no longer holds reads as asked, as every question does where nothing says (a saved transcript,
 * the navigator's label).
 */
export function runPhrase(cards: readonly FinReportCard[], waits: (card: FinReportCard) => boolean = () => false): string {
  const fins = new Map<RunWord, Set<string>>()
  for (const card of cards) {
    const word = runWord(card, asksPerson(card) && waits(card))
    fins.set(word, (fins.get(word) ?? new Set()).add(card.fin))
  }
  const phrases: string[] = []
  let named = false
  for (const [word, one, many] of RUN_WORDS) {
    const count = fins.get(word)?.size
    if (!count) continue
    const verb = count === 1 ? one : many
    if (word === "replied" || word === "silent") phrases.push(`${count} ${count === 1 ? "Apex" : "Apexes"} ${verb}`)
    else {
      phrases.push(named ? `${count} ${verb}` : `${finsWord(count)} ${verb}`)
      named = true
    }
  }
  return phrases.join(" · ")
}
