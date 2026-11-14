import { useAcp } from "@/state/acp"
import { useSetup } from "@/state/setup"
import { useAccountList } from "./account-list"
import { projectOf } from "./threads"

/** What the Thread on screen is, for its Setup: its project as the account broker names it, and the place it runs. */
/** A Thread's project, as the account broker names it, and where it runs, in the words `ThreadSetup` places it by. */
export type ThreadSetupPlace = { project: string | undefined; elsewhere: string | undefined }

export function useThreadSetupPlace(conversation: string | undefined): ThreadSetupPlace {
  const cwd = useAcp((state) => (conversation ? state.conversations[conversation]?.cwd : undefined))
  const runsOn = useAccountList((state) => (conversation ? state.rows.find((row) => row.conversation === conversation)?.runsOn : undefined))
  const device = useAccountList((state) => (runsOn?.kind === "device" ? state.devices.get(runsOn.deviceId)?.name : undefined))
  return { project: projectOf(cwd), elsewhere: runsOn?.kind === "cloud" ? "a cloud machine" : device }
}

/** How many of the Thread on screen's asks wait on the person, in its project's Setup. */
export function useThreadSetupAsks(conversation: string | undefined): number {
  const { project } = useThreadSetupPlace(conversation)
  const thread = useAcp((state) => (conversation ? state.conversations[conversation]?.threadId : undefined))
  return useSetup((state) => (project && thread ? (state.byFolder[project]?.places ?? []).flatMap((place) => place.asks).filter((ask) => ask.by.thread === thread).length : 0))
}
