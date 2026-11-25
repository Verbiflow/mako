import { createContext } from "react"

/** The title of the Settings section on screen, which a group inside it doesn't repeat over itself. */
export const SectionTitleContext = createContext<string | undefined>(undefined)
