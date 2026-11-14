import { notificationsStore } from "@/state/notifications"
import { acpStore } from "@/state/acp-state"
import { hydrateLive } from "@/state/live-recovery"

/** The mock desk's own state, so UI tests never import a second store through a bare Vite URL. */
export const mockState = {
  notifications: () => notificationsStore.get(),
  liveState: () => acpStore.get(),
  hydrateLive,
}
