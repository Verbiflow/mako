import { extensionBrowsers } from "./browser-extension-registration.js"
import { registeredDeskBrowsers } from "./desk-browser-registration.js"

export interface LocalBrowser {
  id: string
  name: string
  endpoint: () => Promise<string>
  requiresApproval?: boolean
  kind?: "chromium" | "desk"
  profile?: string
  origin?: string
  sourceRoot?: string
}

export function localBrowsers(): LocalBrowser[] {
  return [
    ...extensionBrowsers(),
    ...registeredDeskBrowsers(),
  ]
}
