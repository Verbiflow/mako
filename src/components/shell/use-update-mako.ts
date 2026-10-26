import { application, useApplication } from "@/state/application"
import { updates, useUpdates } from "@/state/updates"

/** Update Mako as one action: install a downloaded update, look for one, or open Updates. */
export function useUpdateMakoAction() {
  const status = useUpdates((state) => state.status)
  const distribution = useApplication((state) => state.installation?.distribution)
  const localReady = useApplication((state) => state.installation?.local.kind === "ready")
  const busy = status === "checking" || status === "downloading"
  const label = status === "ready" || localReady ? "Install update" : status === "checking" ? "Checking…" : status === "downloading" ? "Downloading…" : "Update"
  const act = () => {
    if (status === "ready" || localReady) void application.request("install")
    else if (distribution === "signed") void updates.check()
    else window.dispatchEvent(new CustomEvent("mako:settings", { detail: "updates" }))
  }
  return { label, disabled: busy, onClick: act }
}
