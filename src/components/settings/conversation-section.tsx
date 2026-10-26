import { useEffect } from "react"
import { ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { conversationSettings, useConversationSettings } from "@/state/conversation-settings"
import { togglePref, usePrefs } from "@/state/prefs"

export function ConversationSection() {
  const showThinking = usePrefs((prefs) => prefs.showThinking)
  const autoDiff = usePrefs((prefs) => prefs.autoOpenDiff)
  const steerOnEnter = usePrefs((prefs) => prefs.steerOnEnter)
  const settings = useConversationSettings((store) => store.settings)
  useEffect(() => {
    void conversationSettings.load()
  }, [])
  const continueAfterRestart = settings?.continueAfterRestart ?? false

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
        title="Continue interrupted turns after Mako restarts"
        description="When an update or restart cuts a turn short, the agent picks it up once Mako is back, told what stopped with it. At most three times in five minutes; after a crash it waits for you"
      >
        <Toggle
          label="Continue interrupted turns after Mako restarts"
          on={continueAfterRestart}
          disabled={!settings}
          onChange={() => void conversationSettings.set({ continueAfterRestart: !continueAfterRestart })}
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
