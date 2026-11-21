/**
 * The one place this package asks which operating system it runs on, as
 * packages/host/src/base/platform.ts is the host's (`scripts/check-host-platform.mjs`).
 */
export function nodePlatform(): NodeJS.Platform {
  return process.platform
}

export const onMac = (): boolean => process.platform === "darwin"
export const onLinux = (): boolean => process.platform === "linux"
export const onWindows = (): boolean => process.platform === "win32"

/**
 * A Linux desktop a person sits at: a graphical session they logged into, which the login manager names in
 * `XDG_SESSION_TYPE` (x11 or wayland), with its display. A display alone is not one: a CI job under `xvfb-run`, a
 * container's Xvfb or a cloud machine's host has a `DISPLAY` and nobody at it, and must never drive it. A session
 * started without a login manager (`startx` from a console) opts in with `MAKO_DESKTOP_CONTROL=1`; a host started
 * screenless (`MAKO_SCREENLESS=1`, an end-to-end check's beside a person's own) never does. It says how apps draw (X11,
 * or Wayland, where X apps run under XWayland when `xwayland` is set) and whose compositor it is, which decides what
 * Wayland lets an outside process do (GNOME and KDE: portals and libei; wlroots: its own protocols).
 */
export interface LinuxDesktop {
  session: "x11" | "wayland"
  compositor: "gnome" | "kde" | "wlroots" | "other"
  xwayland: boolean
}

export function linuxDesktop(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LinuxDesktop | undefined {
  if (platform !== "linux" || env.MAKO_SCREENLESS === "1") return undefined
  const wayland = Boolean(env.WAYLAND_DISPLAY?.trim())
  const x11 = Boolean(env.DISPLAY?.trim())
  if (!wayland && !x11) return undefined
  const loggedIn = env.XDG_SESSION_TYPE === "x11" || env.XDG_SESSION_TYPE === "wayland"
  if (!loggedIn && env.MAKO_DESKTOP_CONTROL !== "1") return undefined
  const names = [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION].join(":").toLowerCase()
  const compositor = /gnome|unity|ubuntu|pop|budgie/.test(names)
    ? "gnome"
    : /kde|plasma/.test(names)
      ? "kde"
      : env.SWAYSOCK || env.HYPRLAND_INSTANCE_SIGNATURE || /sway|wlroots|hyprland|labwc|river|wayfire|niri/.test(names)
        ? "wlroots"
        : "other"
  return { session: wayland ? "wayland" : "x11", compositor, xwayland: wayland && x11 }
}

/**
 * What to add to a driver's refusal when the cause is something only the person can allow on their Linux desktop
 * (`desktop-grants.ts` in the host): the one action, by the name Settings gives it. Empty for any other refusal.
 */
export function desktopAskHint(refusal: string, desktop: LinuxDesktop | undefined): string {
  if (desktop?.session !== "wayland") return ""
  if (desktop.compositor === "kde" && refusal.includes("org.kde.KWin.ScreenShot2"))
    return ' Window capture isn\'t allowed on this KDE desktop yet: ask the person to press "Allow window capture" in Mako\'s Settings, under Computer use.'
  if (desktop.compositor === "gnome" && /surface_identity_unproven|foreground_unavailable|no trusted Wayland compositor adapter/.test(refusal))
    return ' GNOME needs Mako\'s Shell helper: ask the person to press "Install helper" in Mako\'s Settings, under Computer use, then log out and back in once.'
  return ""
}
