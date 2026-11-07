import type { ScreenRoute } from "./route"
import { Settings } from "./settings"
import { SetupScreen } from "./setup-screen"

/** The desk's own routes for its pane: Settings, and a project's Setup opened from it. */
export type DeskSettingsRoute = Extract<ScreenRoute, { kind: "settings" | "setup" }>

/**
 * The pane a laptop's browser keeps Settings in, and a project's Setup drawn there at the desk's width: the browser is
 * the desktop app, so an agent's ask has the same place to go.
 */
export default function DeskSettings({ route, open }: { route: DeskSettingsRoute; open: (next: ScreenRoute) => void }) {
  if (route.kind === "setup") return <SetupScreen project={route.project} onBack={() => open({ kind: "settings" })} desk />
  return <Settings onBack={undefined} onSetup={(project) => open({ kind: "setup", project })} />
}
