import { createContext, useContext } from "react"

/** True while a laptop's right rail slides away (`desk-side.tsx`). */
export const DeskSideLeaving = createContext(false)

/** True while the right rail slides away: the layer that was showing keeps what it showed until it's gone. */
export function useDeskSideLeaving(): boolean {
  return useContext(DeskSideLeaving)
}
