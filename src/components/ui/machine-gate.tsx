import type { ReactNode } from "react"
import { useCanChooseFolder, useCanReveal } from "@/state/session"

/** Its children only where the host's machine can show a path in a file manager. */
export function IfCanReveal({ children }: { children: ReactNode }) {
  return useCanReveal() ? children : null
}

/** Its children only where a folder can be picked through this client. */
export function IfCanChooseFolder({ children }: { children: ReactNode }) {
  return useCanChooseFolder() ? children : null
}
