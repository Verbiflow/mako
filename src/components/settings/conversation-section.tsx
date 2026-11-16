import { useEffect } from "react"
import { ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { conversationSettings, useConversationSettings } from "@/state/conversation-settings"
import { togglePref, usePrefs } from "@/state/prefs"
import { keepAwake, keepAwakeWarning, useKeepAwake } from "@/state/keep-awake"
import { KEEP_AWAKE_BATTERY_FLOOR } from "@mako/host/contracts/keep-awake"

export function ConversationSection() {
  const showThinking = usePrefs((prefs) => prefs.showThinking)
  const autoDiff = usePrefs((prefs) => prefs.autoOpenDiff)
  const steerOnEnter = usePrefs((prefs) => prefs.steerOnEnter)
  const settings = useConversationSettings((store) => store.settings)
  useEffect(() => {
    void conversationSettings.load()
  }, [])
  const continueAfterRestart = settings?.continueAfterRestart ?? false
  const awake = useKeepAwake((store) => store.state)
  useEffect(() => {
    void keepAwake.load()
  }, [])
  const awakeOn = awake?.settings.on ?? false
  const awakeLid = awake?.settings.lidClosed ?? false
  const awakeOff = !awake || awake.unavailable !== undefined

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
        title="Keep this Mac awake while agents work"
        warning={keepAwakeWarning(awake?.hold)}
        description={awake?.unavailable ?? `Holds off idle sleep while an agent here works or runs a command, not while it waits on you. ${awakeLid ? "" : "Closing the lid still sleeps it. "}Below ${KEEP_AWAKE_BATTERY_FLOOR}% battery, Mako lets the Mac sleep and says so`}
      >
        <Toggle
          label="Keep this Mac awake while agents work"
          on={awakeOn && !awakeOff}
          disabled={awakeOff}
          onChange={() => void keepAwake.set({ on: !awakeOn })}
        />
      </SettingRow>
      <SettingRow
        title="Try to stay awake with the lid closed"
        description="Asks macOS to stay awake, on power only, and it may not. Off, closing the lid sleeps the Mac as usual"
      >
        <Toggle
          label="Try to stay awake with the lid closed"
          on={awakeOn && awakeLid && !awakeOff}
          disabled={awakeOff || !awakeOn}
          onChange={() => void keepAwake.set({ lidClosed: !awakeLid })}
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
