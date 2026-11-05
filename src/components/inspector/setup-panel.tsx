import { ThreadSetup } from "@/components/setup/setup-page"
import { activeAcp, useAcp } from "@/state/acp"

/** The side panel's Setup tab: what the open Thread's own place has, and its asks. */
export function SetupPanel() {
  const cwd = useAcp((state) => activeAcp(state)?.cwd)
  const thread = useAcp((state) => activeAcp(state)?.threadId)
  const elsewhere = useAcp((state) => activeAcp(state)?.elsewhere)
  return <ThreadSetup folder={cwd} thread={thread} elsewhere={elsewhere} />
}
