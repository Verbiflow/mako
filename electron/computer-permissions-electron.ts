import { systemPreferences } from "electron"
import type { PrivacyReadings } from "./computer-permissions.js"

/** macOS's privacy settings for this app, as Electron reads them. */
export const electronPrivacy: PrivacyReadings = {
  accessibility: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
  screen: () => systemPreferences.getMediaAccessStatus("screen"),
}
