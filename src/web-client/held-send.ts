import { createContext } from "react"

/** A send held for the line above the composer (`hold`): `go` sends it as pressed, `take` empties the field and hands its words over. */
export const HeldSendContext = createContext<{ go: () => void; take: () => string } | null>(null)
