import {
  ListCard,
  Segmented,
  SettingRow,
  Toggle,
} from "@/components/ui/kit"
import { setPref, usePrefs, type Theme, type OceanTone } from "@/state/prefs"

export function AppearanceSection() {
  const theme = usePrefs((prefs) => prefs.theme)
  const oceanTone = usePrefs((prefs) => prefs.oceanTone)
  const oceanMotion = usePrefs((prefs) => prefs.oceanMotion)

  return (
    <ListCard>
      <SettingRow
        title="Theme"
        description="Follows the system when set to Auto"
      >
        <Segmented<Theme>
          value={theme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "Auto" },
          ]}
          onChange={(next) => setPref("theme", next)}
        />
      </SettingRow>
      <SettingRow
        title="Ocean color"
        description="Only the opening illustration changes"
      >
        <Segmented<OceanTone>
          value={oceanTone}
          options={[
            { value: "ink", label: "Warm ink" },
            { value: "moon", label: "Silver ink" },
          ]}
          onChange={(next) => setPref("oceanTone", next)}
        />
      </SettingRow>
      <SettingRow
        title="Reflected light"
        description="Pauses while writing and respects reduced motion"
      >
        <Toggle
          label="Reflected light"
          on={oceanMotion}
          onChange={() => setPref("oceanMotion", !oceanMotion)}
        />
      </SettingRow>
    </ListCard>
  )
}
