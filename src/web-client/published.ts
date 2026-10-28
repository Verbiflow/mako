import type * as Published from "../../packages/web-client/index"
import { SignedOutError, startWebApp, type WebAccount, type WebClientOptions, type WebConnection } from "./index"

/**
 * The package's declarations (`packages/web-client/index.d.ts`) held to the code: each side must take the other's, so
 * a change to either that the other doesn't make fails the renderer's typecheck.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const published: [
  Same<Published.WebAccount, WebAccount>,
  Same<Published.WebConnection, WebConnection>,
  Same<Published.WebClientOptions, WebClientOptions>,
  Same<typeof Published.startWebApp, typeof startWebApp>,
  Same<typeof Published.SignedOutError, typeof SignedOutError>,
] = [true, true, true, true, true]
