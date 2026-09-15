import { ListCard, SettingRow } from "@/components/ui/kit"
import { ProviderIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/lib/harness-label"
import {
  LOADOUT_LIMIT,
  moveLoadoutEntry,
  removeFromLoadout,
} from "@/state/model-loadout"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { ArrowDownIcon, ArrowUpIcon, StarIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

/**
 * The model loadout: the five models a chord away, in pick order, and which
 * of them a new conversation starts on.
 */
export function ModelsSection() {
  const loadout = usePrefs((prefs) => prefs.modelLoadout)
  const preferences = usePrefs((prefs) => prefs.providerSettings)

  const makeDefault = (harness: string, model: string) => {
    const current = prefsStore.get().providerSettings[harness]
    setPref("providerSettings", {
      ...prefsStore.get().providerSettings,
      [harness]: {
        source: "saved",
        settings: { ...current?.settings, model },
      },
    })
    toast(`${model} is the default for ${harnessLabel(harness)}`)
  }

  return (
    <ListCard>
      {loadout.map((entry, index) => {
        const isDefault =
          preferences[entry.harness]?.settings.model === entry.model
        return (
          <SettingRow
            key={`${entry.harness}:${entry.model}`}
            title={`⌃⌘${index + 1} · ${entry.model}`}
            description={`${harnessLabel(entry.harness)}${isDefault ? " · default for new conversations" : ""}`}
          >
            <span className="flex items-center gap-0.5">
              <ProviderIcon provider={entry.harness} className="mr-1.5 size-3.5" />
              <button
                type="button"
                aria-label={`Make ${entry.model} the default`}
                title="Make default for new conversations"
                onClick={() => makeDefault(entry.harness, entry.model)}
                className={`pressable rounded p-1 ${isDefault ? "text-foreground" : "text-faint hover:text-foreground"}`}
              >
                <StarIcon className={`size-3.5 ${isDefault ? "fill-current" : ""}`} />
              </button>
              <button
                type="button"
                aria-label="Move earlier"
                disabled={index === 0}
                onClick={() => moveLoadoutEntry(index, -1)}
                className="pressable rounded p-1 text-faint hover:text-foreground disabled:opacity-30"
              >
                <ArrowUpIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Move later"
                disabled={index === loadout.length - 1}
                onClick={() => moveLoadoutEntry(index, 1)}
                className="pressable rounded p-1 text-faint hover:text-foreground disabled:opacity-30"
              >
                <ArrowDownIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Remove ${entry.model} from the loadout`}
                onClick={() => removeFromLoadout(index)}
                className="pressable rounded p-1 text-faint hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </span>
          </SettingRow>
        )
      })}
      {loadout.length === 0 ? (
        <SettingRow
          title="No models in the loadout"
          description={`Add one from the composer's model picker — up to ${LOADOUT_LIMIT}, picked with ⌃⌘1–5`}
        />
      ) : null}
    </ListCard>
  )
}
