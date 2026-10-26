import { createContext } from "react"
import type { LiveRequest } from "@/lib/types"

/**
 * The requests of the conversation on screen that ended without an answer
 * and still offer something, by request id. The live panel provides it; an
 * exchange whose prompt is one of them ends on its failure row.
 */
export const FailedRequestsContext = createContext<ReadonlyMap<string, LiveRequest>>(new Map())
