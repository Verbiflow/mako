import { ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { togglePref, usePrefs } from "@/state/prefs"

export function ConversationSection() {
  const showThinking = usePrefs((prefs) => prefs.showThinking)
  const autoDiff = usePrefs((prefs) => prefs.autoOpenDiff)
  const steerOnEnter = usePrefs((prefs) => prefs.steerOnEnter)

  return (
    <ListCard>
      <SettingRow
        title="Enter steers a running turn"
        description="Off makes Enter queue behind the turn; Cmd+Enter always does the other. Agents that cannot take a message mid-turn queue either way"
      >
        <Toggle
          label="Enter steers a running turn"
          on={steerOnEnter}
          onChange={() => togglePref("steerOnEnter")}
        />
      </SettingRow>
      <SettingRow
        title="Show reasoning"
        description="Collapsed by default; this hides it entirely"
      >
        <Toggle
          label="Show reasoning"
          on={showThinking}
          onChange={() => togglePref("showThinking")}
        />
      </SettingRow>
      <SettingRow
        title="Open the diff on select"
        description="Off keeps the changes panel as a plain list"
      >
        <Toggle
          label="Open the diff on select"
          on={autoDiff}
          onChange={() => togglePref("autoOpenDiff")}
        />
      </SettingRow>
    </ListCard>
  )
}
