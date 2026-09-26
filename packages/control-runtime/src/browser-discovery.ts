import {
  installedChromiumBrowsers,
  mergeInstalledBrowsers,
} from "./browser-installed.js"
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
  /** A desk whose host refuses every call outside the fixture allowlist. */
  fixture?: true
}

export async function localBrowsers(
  additionalApplications: string[] = []
): Promise<LocalBrowser[]> {
  const [installed, extensions] = await Promise.all([
    installedChromiumBrowsers(additionalApplications),
    extensionBrowsers(),
  ])
  return [
    ...mergeInstalledBrowsers(installed, extensions),
    ...registeredDeskBrowsers(),
  ]
}
