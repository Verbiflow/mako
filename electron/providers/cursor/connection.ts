import type {
  ProviderConnectionAction,
  ProviderConnectionState,
} from "../../contracts/provider-connection.js"
import type { ProviderConnectionCapability } from "../connection-capability.js"
import type { CursorSdkAuth, CursorSdkAuthSnapshot } from "./sdk/auth.js"

/** Where a Cursor API key is minted by hand. */
export const CURSOR_API_KEY_URL = "https://cursor.com/dashboard?tab=integrations"

export function cursorConnectionState(snapshot: CursorSdkAuthSnapshot): ProviderConnectionState {
  const { state } = snapshot
  if (state.status === "signed-out") return state.problem ? { status: "signed-out", problem: state.problem } : { status: "signed-out" }
  const projected: ProviderConnectionState = { status: "signed-in", source: state.source }
  if (state.method) projected.method = state.method
  if (state.email) projected.account = state.email
  if (state.keyName) projected.keyName = state.keyName
  if (state.expiresAt) projected.expiresAt = state.expiresAt
  return projected
}

/** Cursor's sign-in as a Settings row: the key every Cursor thread runs under. */
export function cursorConnection(auth: CursorSdkAuth, secureStorage: () => Promise<boolean>): ProviderConnectionCapability {
  return {
    provider: "cursor",
    label: "Cursor",
    description:
      "Every Cursor thread runs through Cursor's SDK under this key. A cursor-agent login on this machine is used on its own; sign in here to use another account or a key of your own.",
    keyUrl: CURSOR_API_KEY_URL,
    secureStorage,
    async status(refresh = false) {
      const snapshot = await auth.status(refresh)
      return { ...cursorConnectionState(snapshot), checkedAt: new Date(snapshot.checkedAt).toISOString() }
    },
    async act(action: Exclude<ProviderConnectionAction, { kind: "refresh" }>) {
      switch (action.kind) {
        case "sign-in-browser":
          return cursorConnectionState(await auth.signInWithBrowser())
        case "sign-in-key":
          return cursorConnectionState(await auth.signInWithKey(action.apiKey))
        case "sign-out":
          return cursorConnectionState(await auth.signOut())
      }
    },
    onChange: (listener) => auth.onChange(() => listener()),
  }
}
