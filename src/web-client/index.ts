import { createElement, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./style.css"
import { Starting, Unreachable } from "./start-screens"
import { WebApp } from "./app"
import { WebClient, WebClientContext, type WebClientOptions } from "./client"
import { SignedOutError } from "./gateway"
import { applyTheme, followSystemTheme } from "./theme"

export { SignedOutError, type WebAccount, type WebConnection } from "./gateway"
export type { WebClientOptions } from "./client"

/**
 * Starts Mako's web app in `element`: signed in with the page's sign-in, the account's Threads followed, each opened
 * on its owner through the gateway and drawn by the desktop's own renderer. Without a sign-in it goes to `signInUrl`.
 */
export async function startWebApp(element: HTMLElement, options: WebClientOptions): Promise<void> {
  applyTheme()
  followSystemTheme()
  const root = createRoot(element)
  root.render(createElement(Starting))
  let client: WebClient
  try {
    client = await WebClient.start(options)
  } catch (error) {
    if (error instanceof SignedOutError) {
      location.assign(options.signInUrl(location.pathname + location.search))
      return
    }
    root.render(createElement(Unreachable, { message: error instanceof Error ? error.message : String(error) }))
    return
  }
  root.render(createElement(StrictMode, null, createElement(WebClientContext, { value: client }, createElement(WebApp))))
}
