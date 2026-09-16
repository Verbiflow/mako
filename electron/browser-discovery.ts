import { extensionBrowsers } from "./browser-extension-registration.js"

export interface LocalBrowser {
  id: string
  name: string
  endpoint: () => Promise<string>
  requiresApproval?: boolean
}

export function localBrowsers(): LocalBrowser[] {
  return extensionBrowsers()
}
