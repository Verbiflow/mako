import { Action } from "@/components/ui/kit"
import type { MakoComputerPermissions } from "@/lib/types"

type DesktopPermission = NonNullable<MakoComputerPermissions["desktop"]>[number]

interface DesktopPermissionCopy {
  title: string
  text: string
  status?: string
  action?: "allow" | "remove"
  label?: string
}

/** What each state of a Linux desktop's ask says, and the one action it offers: allow, or take it away again. */
function desktopPermissionCopy(permission: DesktopPermission): DesktopPermissionCopy {
  const title = permission.id === "kwin-window-capture" ? "Window capture" : "Shell helper"
  // What Mako won't do as things are, with the one thing that changes it.
  if (permission.state === "blocked")
    return permission.reason === "extension-list"
      ? { title, text: "GNOME's extension list holds an entry Mako won't rewrite. Install GNOME's gnome-extensions tool, then install the helper.", action: "allow", label: "Install helper" }
      : { title, text: "Mako's driver is at a path with a space or an unusual character, which this can't be made out to. Reinstall Mako at a plain path." }
  if (permission.id === "kwin-window-capture")
    return permission.state === "granted"
      ? { title: "Window capture", text: "Mako captures the windows it controls, through KWin.", status: "Allowed", action: "remove", label: "Remove" }
      : { title: "Window capture", text: "Lets Mako capture the windows it controls, through KWin.", action: "allow", label: "Allow window capture" }
  if (permission.id === "gnome-shell-helper") {
    if (permission.state === "granted")
      return { title, text: "An extension that lets Mako list your windows, bring one to the front, take its picture and show Mako's pointer. It answers only Mako.", status: "Installed", action: "remove", label: "Uninstall" }
    if (permission.state === "restart")
      return { title, text: "Log out and back in once to finish.", action: "remove", label: "Uninstall" }
    if (permission.state === "extensions-off")
      return { title, text: "GNOME has user extensions turned off.", action: "allow", label: "Turn on user extensions" }
    return { title, text: "GNOME needs Mako's Shell helper: an extension that lets Mako list your windows, bring one to the front, take its picture and show Mako's pointer. It answers only Mako.", action: "allow", label: "Install helper" }
  }
  return { title: "Clicks and typing", text: "Upgrade to KDE Plasma 6.1 or later for these. Mako can still read windows and use app actions." }
}

/** A Linux desktop's asks under Computer use: one row each, with its action. */
export function DesktopPermissions({ permissions, onAllow, onRemove }: { permissions: DesktopPermission[]; onAllow(): void; onRemove(): void }) {
  return (
    <ul aria-label="This desktop" className="mb-6 flex flex-col gap-3">
      {permissions.map((permission) => {
        const copy = desktopPermissionCopy(permission)
        return (
          <li key={permission.id} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h4 className="text-ui font-medium">{copy.title}</h4>
              <p className="mt-1 text-label text-muted-foreground">{copy.text}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {copy.status ? <span className="text-label text-muted-foreground">{copy.status}</span> : null}
              {copy.action ? (
                <Action tone="outline" onClick={copy.action === "allow" ? onAllow : onRemove}>
                  {copy.label}
                </Action>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
