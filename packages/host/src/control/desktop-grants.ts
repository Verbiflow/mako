import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { LinuxDesktop } from "@mako/control-runtime/desktop"
import type { MakoDesktopPermission } from "../contracts/mcp-skills-integrations.js"
import { findExecutable } from "../base/executable.js"
import { hostCommand } from "../base/host-command.js"

/**
 * What a Linux desktop asks of the person before computer use is whole, and the one action for each. Nothing here
 * happens on its own: the host reads the state (`desktopPermissions`), and writes or removes anything only when the
 * person presses the action in Settings (`grantDesktopPermissions`, `revokeDesktopPermissions`).
 *
 * - **KDE, window capture.** KWin gives a window's pixels (`org.kde.KWin.ScreenShot2`) only to a program whose desktop
 *   entry asks for them, the way Spectacle's does. Allowing writes that entry for Mako's driver into the person's own
 *   applications folder, by the driver's whole path and hidden from the app menu; removing it deletes the file.
 * - **GNOME, the Shell helper.** GNOME lets no outside program list or activate windows. Mako's helper is a Shell
 *   extension (`winrects@cua`, shipped beside the driver) that does both. Installing copies it into the person's
 *   extensions folder and enables it; the Shell loads a new extension only at login, so until then it is installed
 *   and not yet running, which is its own state. Removing deletes the folder and takes it off the enabled list.
 * - **KDE Plasma 5, pointer and keyboard.** Its portal hands out no libei connection: nothing to grant, and the row
 *   says what would change it.
 */
export const KWIN_CAPTURE_ENTRY = "app.mako.computer-control.desktop"
export const GNOME_HELPER = "winrects@cua"
const GNOME_HELPER_FILES = ["metadata.json", "extension.js"] as const

/** What the grants are read and made with: a test gives a home, a driver and programs of its own. */
export interface DesktopGrantContext {
  env: NodeJS.ProcessEnv
  home: string
  /** The driver the host starts, by its whole path; none when it isn't installed. */
  driver(): Promise<string | null>
  /** A system program by its whole path (`gsettings`, `gdbus`); none when the desktop has none. */
  program(name: string): Promise<string | null>
  run(program: string, args: string[]): Promise<string>
}

export function desktopGrantContext(driver: () => Promise<string | null>, env: NodeJS.ProcessEnv = process.env): DesktopGrantContext {
  return {
    env,
    home: env.HOME?.trim() || homedir(),
    driver,
    program: (name) => findExecutable(name, env),
    run: async (program, args) => (await hostCommand(program, args, { timeout: 5_000, env })).stdout,
  }
}

export function kwinCaptureEntry(driver: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Mako computer control",
    "Comment=Lets Mako capture the windows it controls through KWin. Delete this file to stop that.",
    `Exec=${driver}`,
    "NoDisplay=true",
    "X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2",
    "",
  ].join("\n")
}

function dataHome(context: DesktopGrantContext): string {
  return context.env.XDG_DATA_HOME?.trim() || join(context.home, ".local", "share")
}

/** The driver by the path KWin sees it run from; none when KWin could never match it (its first word only). */
async function matchableDriver(context: DesktopGrantContext): Promise<string | undefined> {
  const driver = await context.driver()
  const program = driver ? await realpath(driver).catch(() => undefined) : undefined
  return program && !/\s/.test(program) ? program : undefined
}

async function kwinCapture(context: DesktopGrantContext): Promise<MakoDesktopPermission> {
  const driver = await matchableDriver(context)
  const entry = await readFile(join(dataHome(context), "applications", KWIN_CAPTURE_ENTRY), "utf8").catch(() => undefined)
  return { id: "kwin-window-capture", state: driver && entry === kwinCaptureEntry(driver) ? "granted" : "needed" }
}

function helperFolder(context: DesktopGrantContext): string {
  return join(dataHome(context), "gnome-shell", "extensions", GNOME_HELPER)
}

/** The helper as this install ships it, beside the driver; none when the install has none. */
async function shippedHelper(context: DesktopGrantContext): Promise<Map<string, string> | undefined> {
  const driver = await context.driver()
  const program = driver ? await realpath(driver).catch(() => undefined) : undefined
  if (!program) return undefined
  const files = new Map<string, string>()
  for (const name of GNOME_HELPER_FILES) {
    const text = await readFile(join(dirname(program), "wayland-helper", GNOME_HELPER, name), "utf8").catch(() => undefined)
    if (text === undefined) return undefined
    files.set(name, text)
  }
  return files
}

async function enabledExtensions(context: DesktopGrantContext): Promise<{ gsettings: string; enabled: string[] } | undefined> {
  const gsettings = await context.program("gsettings")
  if (!gsettings) return undefined
  const listed = await context.run(gsettings, ["get", "org.gnome.shell", "enabled-extensions"]).catch(() => undefined)
  return listed === undefined ? undefined : { gsettings, enabled: [...listed.matchAll(/'([^']*)'/g)].map((match) => match[1]!) }
}

function setEnabledExtensions(context: DesktopGrantContext, gsettings: string, enabled: string[]): Promise<string> {
  return context.run(gsettings, ["set", "org.gnome.shell", "enabled-extensions", `[${enabled.map((name) => `'${name}'`).join(", ")}]`])
}

/** The version of the helper the running Shell answers with on the session bus; none when it isn't running. */
async function runningHelper(context: DesktopGrantContext): Promise<number | undefined> {
  const gdbus = await context.program("gdbus")
  if (!gdbus) return undefined
  const answer = await context
    .run(gdbus, ["call", "--session", "--timeout", "2", "--dest", "org.cua.WinRects", "--object-path", "/org/cua/WinRects", "--method", "org.cua.WinRects.GetVersion"])
    .catch(() => undefined)
  const version = answer ? /(\d+)/.exec(answer.replace("uint32", ""))?.[1] : undefined
  return version ? Number(version) : undefined
}

async function gnomeHelper(context: DesktopGrantContext): Promise<MakoDesktopPermission> {
  const shipped = await shippedHelper(context)
  const installed = shipped
    ? (await Promise.all([...shipped].map(async ([name, text]) => (await readFile(join(helperFolder(context), name), "utf8").catch(() => undefined)) === text))).every(Boolean)
    : false
  const enabled = (await enabledExtensions(context))?.enabled.includes(GNOME_HELPER) ?? false
  if (!installed || !enabled) return { id: "gnome-shell-helper", state: "needed" }
  // Installed and enabled. The Shell runs it from its next start: an older one still answering is not this one.
  const wanted = Number(/"version"\s*:\s*(\d+)/.exec(shipped?.get("metadata.json") ?? "")?.[1])
  return { id: "gnome-shell-helper", state: (await runningHelper(context)) === wanted ? "granted" : "restart" }
}

/** Each thing this desktop asks for, with where it stands; none on X11 and wlroots, which ask for nothing. */
export async function desktopPermissions(desktop: LinuxDesktop | undefined, context: DesktopGrantContext): Promise<MakoDesktopPermission[]> {
  if (desktop?.session !== "wayland") return []
  if (desktop.compositor === "gnome") return [await gnomeHelper(context)]
  if (desktop.compositor !== "kde") return []
  const capture = await kwinCapture(context)
  return context.env.KDE_SESSION_VERSION === "5" ? [capture, { id: "pointer-input", state: "unavailable" }] : [capture]
}

/** The person's action: allow what this desktop still needs. It says why when it can't. */
export async function grantDesktopPermissions(desktop: LinuxDesktop | undefined, context: DesktopGrantContext): Promise<void> {
  if (desktop?.session !== "wayland") return
  if (desktop.compositor === "kde") {
    const driver = await matchableDriver(context)
    if (!driver) throw new Error("Mako's computer control driver isn't installed where KWin can match it; window capture can't be allowed yet.")
    const folder = join(dataHome(context), "applications")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, KWIN_CAPTURE_ENTRY), kwinCaptureEntry(driver), { mode: 0o644 })
    return
  }
  if (desktop.compositor !== "gnome") return
  const shipped = await shippedHelper(context)
  if (!shipped) throw new Error("This install of Mako has no Shell helper beside its computer control driver; reinstall Mako to get it.")
  const extensions = await enabledExtensions(context)
  if (!extensions) throw new Error("GNOME's settings (gsettings) didn't answer, so the helper can't be enabled; nothing was installed.")
  await mkdir(helperFolder(context), { recursive: true })
  for (const [name, text] of shipped) await writeFile(join(helperFolder(context), name), text, { mode: 0o644 })
  if (!extensions.enabled.includes(GNOME_HELPER)) await setEnabledExtensions(context, extensions.gsettings, [...extensions.enabled, GNOME_HELPER])
}

/** The person's action: take away what Mako put on this desktop. */
export async function revokeDesktopPermissions(desktop: LinuxDesktop | undefined, context: DesktopGrantContext): Promise<void> {
  if (desktop?.session !== "wayland") return
  if (desktop.compositor === "kde") await rm(join(dataHome(context), "applications", KWIN_CAPTURE_ENTRY), { force: true })
  if (desktop.compositor !== "gnome") return
  const extensions = await enabledExtensions(context)
  if (extensions?.enabled.includes(GNOME_HELPER))
    await setEnabledExtensions(context, extensions.gsettings, extensions.enabled.filter((name) => name !== GNOME_HELPER))
  await rm(helperFolder(context), { recursive: true, force: true })
}

/** Whether anything still waits on the person's action or their next login. */
export function desktopPermissionsPending(permissions: MakoDesktopPermission[]): boolean {
  return permissions.some((permission) => permission.state === "needed" || permission.state === "restart")
}
