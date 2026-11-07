import type { ReactNode } from "react"
import type { ComposerNotice } from "@/extend/notices"

/**
 * An ask waiting on the person, in the one shape every surface draws it: an agent's ask (#461's `agentAskWords`: its
 * line, the rest of it, why, allow and keep) and a source's ask in Setup alike. Each stays in its own store, the
 * conversation's control or its broker; what they share is how they're said and answered, so the composer's notice and
 * the Inbox draw both the same way.
 */
export type AskChoice = {
  label: string
  /** The one to take first; drawn filled. At most one. */
  primary?: boolean
  /** Answers the ask: true once the answer landed, false when it didn't (the host refused it, or what it allowed failed). */
  choose: () => void | Promise<boolean>
  /** What the choice is, for tests and styling (`data-inbox-answer`). */
  answer: string
}

export type AskCard = {
  /** Who asks: a Thread's title, often its first message and long, so it's what gives way. */
  who: string
  /** What it asks for, always said whole: "wants a copy of .env.local". */
  want: string
  /** The rest of what it wants. */
  description?: string
  /** Why, and what answering does: what the line leaves out. */
  detail?: string
  /** Said beside the answers when the one the ask wants can't be given here. */
  note?: string
  choices: AskChoice[]
}

/**
 * How tall an ask's answers are under a finger, wherever the card is drawn: 44 px, as the dock's ask rows, so a phone's
 * Decline is as easy to hit as any other answer there. Under a mouse the card keeps its own height.
 */
export const ASK_TOUCH = "[@media(pointer:coarse)]:h-11"

/**
 * Runs a choice with its row held busy. An answer that didn't land, or failed, frees the row, so the ask stays open and
 * can be answered again; one that landed keeps it held until the ask goes. A choice that says nothing is taken as landed.
 */
export async function runChoice(choice: AskChoice, busy: (held: boolean) => void): Promise<boolean> {
  busy(true)
  const landed = await Promise.resolve(choice.choose()).then((said) => said ?? true, () => false)
  if (!landed) busy(false)
  return landed
}

/** An ask's want as a line of its own: "Wants a copy of .env.local". */
export function wantLine(card: Pick<AskCard, "want">): string {
  return card.want.charAt(0).toUpperCase() + card.want.slice(1)
}

/**
 * An ask as a notice above the composer: in the attention hue, ahead of the stack's other notices. It stands in the
 * asking Thread itself, so its line is the want, whole; the icon says which agent asked.
 */
export function askNotice(id: string, card: AskCard, extra: { icon?: ReactNode; data?: ComposerNotice["data"] } = {}): ComposerNotice {
  const description = [card.description, card.note].filter(Boolean).join(". ")
  return {
    id,
    tone: "attention",
    priority: 0,
    ...(extra.icon !== undefined && { icon: extra.icon }),
    title: wantLine(card),
    ...(description && { description }),
    ...(card.detail && { detail: card.detail }),
    actions: card.choices.map((choice) => ({ label: choice.label, ...(choice.primary && { primary: true }), onClick: choice.choose })),
    ...(extra.data && { data: extra.data }),
  }
}
