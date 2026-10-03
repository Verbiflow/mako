import { useCallback, useEffect, useState } from "react"
import { SettingRow } from "@/components/ui/kit"
import { SearchSelect } from "@/components/ui/search-select"
import { ProviderIcon } from "@/components/ui/provider-icon"
import { utilityModels } from "@/state/model-runtime"
import type { UtilityModelSettings } from "@/lib/types"

const OFF = "off"

/**
 * Which connected model names Threads, if any. The connections are the
 * ones commit drafting uses; with none, the row says where to add one.
 */
export function ThreadTitleSetting() {
  const [settings, setSettings] = useState<UtilityModelSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSettings(await utilityModels.settings())
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Model connections could not be loaded.")
    }
  }, [])

  const choose = async (next: string) => {
    try {
      await utilityModels.setTitleModel(next === OFF ? null : next)
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

  const connections = settings?.connections ?? []
  const chosen = settings?.titleModel
  const lost = chosen && !connections.some((connection) => `${connection.provider}/${connection.model}` === chosen)
  const description = error
    ? error
    : !settings
      ? "Loading model connections"
      : lost
        ? `${chosen} is no longer connected, so threads keep the names they have. Choose another model or turn this off`
        : connections.length
          ? "After each answer, Mako sends the thread's last two exchanges to this model for a short name. A thread you rename keeps your name"
          : "Connect a model in Settings > Commit messages, then choose it here. Until then, threads keep the names their agents give them"

  return (
    <SettingRow title="Name threads automatically" description={description}>
      <SearchSelect
        value={settings?.titleModel ?? OFF}
        label="Model that names threads"
        searchPlaceholder="Search connected models"
        className="w-56 max-w-full"
        disabled={!settings || (!connections.length && !chosen)}
        options={[
          { value: OFF, label: "Off" },
          ...connections.map((connection) => ({
            value: `${connection.provider}/${connection.model}`,
            label: connection.model,
            detail: settings?.providers.find((provider) => provider.id === connection.provider)?.name,
            icon: <ProviderIcon provider={connection.provider} tinted={false} className="size-3.5" />,
          })),
        ]}
        onChange={(next) => void choose(next)}
      />
    </SettingRow>
  )
}
