import { createContext } from "react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"

/** How this window opens one of an Apex's Fins from its transcript: in place on the desktop (`openFinInApex`), the phone's own way there. */
export const RoutedOpenContext = createContext<((agent: NativeAgent) => void) | undefined>(undefined)
