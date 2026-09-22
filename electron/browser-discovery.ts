import { regularDebuggingBrowsers } from "./browser-debugging-profiles.js"
import { extensionBrowsers } from "./browser-extension-registration.js"
import { registeredDeskBrowsers } from "./desk-browser-registration.js"

export interface LocalBrowser {
  id: string
  name: string
  endpoint: () => Promise<string>
  requiresApproval?: boolean
  applicationPath?: string
  product?: string
  profileName?: string
  transport?: "extension" | "direct"
  kind?: "chromium" | "desk"
  profile?: string
  origin?: string
  sourceRoot?: string
}

export async function localBrowsers(): Promise<LocalBrowser[]> {
  return [
    ...(await extensionBrowsers()),
    ...(await regularDebuggingBrowsers()),
    ...registeredDeskBrowsers(),
  ]
}
