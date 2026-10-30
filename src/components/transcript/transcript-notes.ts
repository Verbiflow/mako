import { createContext, type ReactNode } from "react"

/**
 * What a surface says under a message the person sent, beside its time: the phone's delivery state ("Sending…",
 * "Delivered", "Not confirmed · Retry"), by the message's request ID. The desk says nothing there.
 */
export const PromptNoteContext = createContext<((requestId: string | undefined) => ReactNode) | null>(null)

/**
 * What a surface adds at the end of a turn, by the exchange's ID: the phone's one-line record of an approval or a
 * question it answered from its dock while the turn ran ("Allowed once · npm test"). The desk adds nothing.
 */
export const ExchangeNoteContext = createContext<((exchangeId: string) => ReactNode) | null>(null)
