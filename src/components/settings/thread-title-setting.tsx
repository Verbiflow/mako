import { useCallback, useEffect, useState } from "react"
import { SettingRow } from "@/components/ui/kit"
import { utilityModels } from "@/state/model-runtime"
import { UTILITY_OFF, type UtilityModelSettings } from "@/lib/types"
import { UtilityModelPicker } from "./utility-model-picker"

/**
 * Which model names Threads. Automatic picks a light model from a
 * signed-in agent app, on the person's own account, the same way commit
 * drafting does; Off keeps the names agents give.
 */
export function ThreadTitleSetting() {
  const [settings, setSettings] = useState<UtilityModelSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSettings(await utilityModels.settings())
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Models could not be loaded.")
    }
  }, [])

  const choose = async (next: string) => {
    try {
      await utilityModels.choose("title", next)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The choice could not be saved. Try again.")
    }
  }

  useEffect(() => {
    queueMicrotask(() => void refresh())
    const focus = () => void refresh()
    window.addEventListener("focus", focus)
    return () => window.removeEventListener("focus", focus)
  }, [refresh])

  const state = settings?.work?.title
  const description = error
    ? error
    : !state
      ? "Loading models"
      : state.choice === UTILITY_OFF
        ? "Threads keep the names their agents give them"
        : state.resolved
          ? `After each answer, ${state.resolved.via}’s ${state.resolved.label} reads the thread's first request and its last three exchanges, and renames it only when the work has moved on. A thread you rename keeps your name`
          : `${state.reason ?? "No model can name threads now."} Until then, threads keep the names they have`

  return (
    <SettingRow title="Name threads automatically" description={description}>
      <UtilityModelPicker task="title" state={state} label="Model that names threads" className="w-56 max-w-full" onChoose={(next) => void choose(next)} />
    </SettingRow>
  )
}
