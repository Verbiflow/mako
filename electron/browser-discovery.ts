import {
  installedChromiumBrowsers,
  mergeInstalledBrowsers,
} from "./browser-installed.js"
import { regularDebuggingBrowsers } from "./browser-debugging-profiles.js"
import { extensionBrowsers } from "./browser-extension-registration.js"
import { registeredDeskBrowsers } from "./desk-browser-registration.js"

export interface LocalBrowser {
  id: string
  name: string
  endpoint: () => Promise<string>
  requiresApproval?: boolean
  applicationPath?: string
  setupRequired?: boolean
  icon?: string
  product?: string
  profileName?: string
  transport?: "extension" | "direct"
  kind?: "chromium" | "desk"
  profile?: string
  origin?: string
  sourceRoot?: string
}

export async function localBrowsers(
  additionalApplications: string[] = []
): Promise<LocalBrowser[]> {
  const [installed, extensions, direct] = await Promise.all([
    installedChromiumBrowsers(additionalApplications),
    extensionBrowsers(),
    regularDebuggingBrowsers(),
  ])
  return [
    ...mergeInstalledBrowsers(installed, extensions),
    ...direct,
    ...registeredDeskBrowsers(),
  ]
}
