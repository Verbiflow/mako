import { pullsPane } from "@/state/inbox-view"
import { stage } from "@/state/stage"
import { viewer } from "@/state/viewer"

/** The Pull requests page in the main pane, over the conversation, as the Inbox opens. */
export function openPullsPage(): void {
  viewer.showAgent()
  stage.showChat()
  pullsPane.open()
}
