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
 * A Linux desktop a person sits at, as its session's environment says: how apps draw (X11, or Wayland, where X apps
 * run under XWayland when `xwayland` is set) and whose compositor it is, which decides what Wayland lets an outside
 * process do (GNOME and KDE: portals and libei; wlroots: its own protocols). None off Linux, and on a Linux machine
 * with no display (a server, a cloud machine's host), whose computer control is the standalone runtime's.
 */
export interface LinuxDesktop {
  session: "x11" | "wayland"
  compositor: "gnome" | "kde" | "wlroots" | "other"
  xwayland: boolean
}

export function linuxDesktop(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LinuxDesktop | undefined {
  // A host started screenless (an end-to-end check's beside a person's own) drives no desktop.
  if (platform !== "linux" || env.MAKO_SCREENLESS === "1") return undefined
  const wayland = Boolean(env.WAYLAND_DISPLAY?.trim())
  const x11 = Boolean(env.DISPLAY?.trim())
  if (!wayland && !x11) return undefined
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
