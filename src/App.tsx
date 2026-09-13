import { useEffect } from "react"
import { bindFeedback } from "@/state/feedback"
import { bindNotifications } from "@/state/notifications-desk"
import { AppShell } from "@/components/shell/app-shell"
import { showNotificationToast } from "@/components/notifications/notification-toast"
import { Toaster } from "@/components/ui/sonner"

/** The titlebar is a 38px drag region; a toast on it would drag the window. */
const TOAST_OFFSET = { top: 46, right: 12 }

/** A receipt reads in three seconds; anything that matters longer is in the transcript. */
const TOAST_MS = 3000

function bindDeskNotifications() {
  return bindNotifications({ toast: showNotificationToast })
}

export function App() {
  useEffect(bindFeedback, [])
  useEffect(bindDeskNotifications, [])
  return (
    <>
      <AppShell />
      <Toaster position="top-right" offset={TOAST_OFFSET} duration={TOAST_MS} />
    </>
  )
}

export default App
