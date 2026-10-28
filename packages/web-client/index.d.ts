// The web client's public face, as `src/web-client/index.ts` exports it; `src/web-client/published.ts` holds the two
// to each other, so this can't drift from the code it describes.

/** Who a browser is signed in as. */
export interface WebAccount {
  id: string
  name: string
  email: string
  image: string | null
  entitlements: string[]
}

/** A connection token for a browser's sign-in: good for minutes, renewed in each socket. */
export interface WebConnection {
  token: string
  /** When it runs out, in ms since the epoch. */
  expiresAt: number
  deviceId: string
  account: WebAccount
}

/** What the page hosting the client gives it. */
export interface WebClientOptions {
  /** The gateway's origin: the page's own. */
  origin: string
  /** The path the app is served under, ending in `/`: `/app/`. */
  base: string
  /** A connection token for this browser's sign-in; rejects with `SignedOutError` once it ended. */
  connect(): Promise<WebConnection>
  /** Ends this browser's sign-in, everywhere at once. */
  signOut(): Promise<void>
  /** Where a person signs in, coming back to `next`. */
  signInUrl(next: string): string
  /** The build serving the page, for Diagnostics. */
  build?: string
  /**
   * Called once, after the app's first screen has painted with the account's Threads and the screens it reads next (a
   * Thread, New) have arrived: the moment for the page's own work that can wait, such as installing its service worker.
   */
  painted?(): void
}

/** The browser's sign-in ended: signed out here or on another device, or it ran out. */
export declare class SignedOutError extends Error {
  constructor(message?: string)
}

/** Starts Mako's web app in `element`. */
export declare function startWebApp(element: HTMLElement, options: WebClientOptions): Promise<void>
