import { createContext } from "react"

/** What "Show in Agents" opens: the desk's Agents panel, unless the surface brings its own (a phone's sheet). */
export const ShowAgentsContext = createContext<(() => void) | null>(null)
