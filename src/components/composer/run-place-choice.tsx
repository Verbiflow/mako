import { CloudIcon, LaptopIcon } from "lucide-react"
import { useCloudAccount } from "@/state/cloud-account"
import { runPlaceStore, useRunPlace } from "@/state/run-place"
import { useSession } from "@/state/session"
import { useOnScreen } from "@/state/thread-sessions"

const triggerClass = "pressable flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground aria-pressed:text-foreground"

/**
 * The composer's Local/Cloud choice for a new Thread in a Git project, for an
 * account with the cloud. In the cloud it runs on a machine of the account's,
 * in a clone of the folder's GitHub repository on its upstream branch.
 */
export function RunPlaceChoice() {
  const here = useOnScreen()
  const cloud = useRunPlace((state) => state.cloud)
  const inRepository = useSession((state) => Boolean(state.git?.root))
  const invited = useCloudAccount((state) => state.account?.state.status === "signed-in" && state.account.state.account.entitlements.includes("cloud"))
  if (here.thread || here.draft || here.cwd || !inRepository || !invited) return null
  const describe = cloud ? "Runs in the cloud, in a clone of this project's GitHub repository" : "Runs on this Mac"
  return (
    <button
      type="button"
      data-run-place={cloud ? "cloud" : "local"}
      aria-pressed={cloud}
      aria-label={`${describe}. Switch to ${cloud ? "this Mac" : "the cloud"}`}
      title={describe}
      onClick={() => runPlaceStore.set({ cloud: !cloud })}
      className={triggerClass}
    >
      {cloud ? <CloudIcon className="size-3 shrink-0" /> : <LaptopIcon className="size-3 shrink-0" />}
      <span data-collapse="1" className="truncate">
        {cloud ? "Cloud" : "Local"}
      </span>
    </button>
  )
}
