import { activeAcp, useAcp } from "@/state/acp"

/** Whether the rail offers Setup: while a Thread is open, whose place it has to show. The open surface keeps its row. */
export function useSetupOffered(): boolean {
  return useAcp((state) => Boolean(activeAcp(state)?.cwd))
}
