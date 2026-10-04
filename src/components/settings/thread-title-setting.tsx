import { useEffect, useState } from "react"
import { Action, SettingRow } from "@/components/ui/kit"
import { utilityModels } from "@/state/model-runtime"
import { UTILITY_OFF, type UtilityTaskState } from "@/lib/types"

/**
 * Whether and with what Threads are named. The choice itself lives in
 * Settings › Models with every other model Mako picks; this row says what
 * it is and goes there.
 */
export function ThreadTitleSetting() {
  const [state, setState] = useState<UtilityTaskState | null>(null)

  useEffect(() => {
    const refresh = () =>
      void utilityModels
        .settings()
        .then((settings) => setState(settings.work?.title ?? null))
        .catch(() => setState(null))
    queueMicrotask(refresh)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  const description = !state
    ? "Threads are renamed as their work moves on. A thread you rename keeps your name"
    : state.choice === UTILITY_OFF
      ? "Off. Threads keep the names their agents give them"
      : state.resolved
        ? `${state.resolved.label} · ${state.resolved.via} renames a thread when its work has moved on. A thread you rename keeps your name`
        : `${state.reason ?? "No model can name threads now."} Until then, threads keep the names they have`

  return (
    <SettingRow title="Name threads automatically" description={description}>
      <Action tone="outline" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "models" }))}>
        Change in Models
      </Action>
    </SettingRow>
  )
}
