import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Action, Eyebrow, ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { playFeedback } from "@/state/feedback"
import {
  refreshNotificationPermission,
  requestNotificationPermission,
  sendTestNotification,
  useNotifications,
} from "@/state/notifications"
import { setPref, togglePref, usePrefs } from "@/state/prefs"

/**
 * Notifications: when Mako reaches you outside the window, and what counts.
 *
 * The policy is stated where the user meets it — banners only while Mako is
 * in the background, a toast when a different thread finishes in front of
 * you, nothing for the thread you are watching — because "it notified me
 * while the app was open" is otherwise filed as a bug.
 */
export function NotificationsSection() {
  const desktop = usePrefs((prefs) => prefs.notifyDesktop)
  const ready = usePrefs((prefs) => prefs.notifyReady)
  const ask = usePrefs((prefs) => prefs.notifyAsk)
  const failed = usePrefs((prefs) => prefs.notifyFailed)
  const badge = usePrefs((prefs) => prefs.badgeCount)
  const sound = usePrefs((prefs) => prefs.soundEnabled)
  const volume = usePrefs((prefs) => prefs.soundVolume)
  const permission = useNotifications((state) => state.permission)
  const [testing, setTesting] = useState(false)

  // The user may flip the switch in System Settings and come back: re-read
  // the platform's answer whenever the window regains focus.
  useEffect(() => {
    void refreshNotificationPermission()
    const refresh = () => void refreshNotificationPermission()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  const enableDesktop = () => {
    const next = !desktop
    setPref("notifyDesktop", next)
    if (next) void requestNotificationPermission()
  }

  const test = async () => {
    setTesting(true)
    try {
      const delivered = await sendTestNotification()
      if (!delivered) {
        toast.error("The notification was not delivered", {
          description:
            permission === "unsupported"
              ? "This desk cannot show desktop notifications."
              : permission === "unsigned"
                ? "macOS refuses banners from an unsigned checkout. Use the installed app."
                : "Allow Mako under System Settings > Notifications, then try again.",
        })
      }
      await refreshNotificationPermission()
      if (delivered)
        toast.success("Handed to the system", {
          description: "If nothing appeared, check System Settings > Notifications.",
        })
    } finally {
      setTesting(false)
    }
  }

  const blocked = desktop && permission === "denied"

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Outside the window</Eyebrow>
        <ListCard>
          <SettingRow
            title="Desktop notifications"
            description={
              blocked
                ? "Blocked by the system. Allow Mako under System Settings > Notifications."
                : permission === "unsigned"
                  ? "A checkout runs unsigned, and macOS refuses its banners. The installed app can notify."
                  : permission === "unsupported"
                    ? "Not available on this desk"
                    : permission === "default" && desktop
                      ? "macOS asks once, on the first banner. Send the test one to answer now."
                      : "While Mako is in the background. Click one to open its thread."
            }
          >
            <Toggle
              label="Desktop notifications"
              on={desktop}
              disabled={permission === "unsupported" || permission === "unsigned"}
              onChange={enableDesktop}
            />
          </SettingRow>
          <SettingRow
            title="Count on the app icon"
            description="Threads with something you have not seen"
          >
            <Toggle
              label="Count on the app icon"
              on={badge}
              onChange={() => togglePref("badgeCount")}
            />
          </SettingRow>
          <SettingRow
            title="Send a test notification"
            description="Proves the whole path, and asks the system for permission the first time"
          >
            <Action disabled={testing || !desktop} onClick={() => void test()}>
              Send
            </Action>
          </SettingRow>
        </ListCard>
      </div>

      <div className="flex flex-col gap-2">
        <Eyebrow>Tell me when</Eyebrow>
        <ListCard>
          <SettingRow
            title="An answer is ready"
            description="A turn finished in a thread you were not watching"
          >
            <Toggle label="An answer is ready" on={ready} onChange={() => togglePref("notifyReady")} />
          </SettingRow>
          <SettingRow
            title="An agent needs me"
            description="An approval or a question is waiting"
          >
            <Toggle label="An agent needs me" on={ask} onChange={() => togglePref("notifyAsk")} />
          </SettingRow>
          <SettingRow title="A run fails" description="Only as a banner; the error itself shows in the thread">
            <Toggle label="A run fails" on={failed} onChange={() => togglePref("notifyFailed")} />
          </SettingRow>
        </ListCard>
      </div>

      <div className="flex flex-col gap-2">
        <Eyebrow>Sound</Eyebrow>
        <ListCard>
          <SettingRow
            title="Interface sounds"
            description="A quiet cue when a reply lands in front of you; banners carry their own"
          >
            <Toggle
              label="Interface sounds"
              on={sound}
              onChange={() => setPref("soundEnabled", !sound)}
            />
          </SettingRow>
          <SettingRow title="Volume" description="Preview the completion sound">
            <input
              aria-label="Sound volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              disabled={!sound}
              className="w-24 accent-foreground"
              onChange={(event) => setPref("soundVolume", Number(event.target.value))}
            />
            <Action disabled={!sound} onClick={() => playFeedback("complete")}>
              Preview
            </Action>
          </SettingRow>
        </ListCard>
      </div>
    </div>
  )
}
