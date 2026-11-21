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
 *   extensions folder, with the driver's whole path beside it (the helper answers that program alone), and enables
 *   it; the Shell loads a new extension only at login, so until then it is installed and not yet running, which is
 *   its own state. Where GNOME has user extensions turned off, turning them on is a step of its own, on the person's
 *   click. Removing deletes the folder and takes it off the enabled list.
 * - **KDE Plasma 5, pointer and keyboard.** Its portal hands out no libei connection: nothing to grant, and the row
 *   says what would change it.
 */
export const KWIN_CAPTURE_ENTRY = "app.mako.computer-control.desktop"
export const GNOME_HELPER = "winrects@cua"
const GNOME_HELPER_FILES = ["metadata.json", "extension.js"] as const
/** A driver path a desktop entry's `Exec` and the helper's caller check can hold with no quoting at all. */
const PLAIN_PATH = /^[A-Za-z0-9/._+-]+$/

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

/** The driver by the path it runs from; none when it isn't installed, or its path is not a plain one. */
async function plainDriver(context: DesktopGrantContext): Promise<{ program?: string; installed: boolean }> {
  const driver = await context.driver()
  const program = driver ? await realpath(driver).catch(() => undefined) : undefined
  return { installed: Boolean(program), ...(program && PLAIN_PATH.test(program) && { program }) }
}

async function kwinCapture(context: DesktopGrantContext): Promise<MakoDesktopPermission> {
  const driver = await plainDriver(context)
  // KWin matches an entry's `Exec` by its first word, and the entry is a file other programs read: a path with a
  // space or anything a desktop entry would need quoted is never written into one.
  if (driver.installed && !driver.program) return { id: "kwin-window-capture", state: "blocked", reason: "driver-path" }
  const entry = await readFile(join(dataHome(context), "applications", KWIN_CAPTURE_ENTRY), "utf8").catch(() => undefined)
  return { id: "kwin-window-capture", state: driver.program && entry === kwinCaptureEntry(driver.program) ? "granted" : "needed" }
}

function helperFolder(context: DesktopGrantContext): string {
  return join(dataHome(context), "gnome-shell", "extensions", GNOME_HELPER)
}

/** The helper as this install ships it, beside the driver, and the driver it will answer; none when the install has none. */
async function shippedHelper(context: DesktopGrantContext): Promise<Map<string, string> | undefined> {
  const { program } = await plainDriver(context)
  if (!program) return undefined
  const files = new Map<string, string>()
  for (const name of GNOME_HELPER_FILES) {
    const text = await readFile(join(dirname(program), "wayland-helper", GNOME_HELPER, name), "utf8").catch(() => undefined)
    if (text === undefined) return undefined
    files.set(name, text)
  }
  files.set("driver", `${program}\n`)
  return files
}

/**
 * GNOME's list of enabled extensions, as `gsettings` prints it. It is the person's list: it is edited through
 * `gnome-extensions`, which changes its own entry only, and where that tool is missing, by adding or cutting this
 * helper's own quoted id in the printed text, and only when that text holds nothing but plain single-quoted ids. A
 * list printed with a double quote or a backslash (an id with an apostrophe in it) is never rewritten.
 */
interface ExtensionSettings {
  gsettings: string
  tool: string | null
  listed: string
  enabled: boolean
  off: boolean
  editable: boolean
}

async function extensionSettings(context: DesktopGrantContext): Promise<ExtensionSettings | undefined> {
  const gsettings = await context.program("gsettings")
  if (!gsettings) return undefined
  const listed = await context.run(gsettings, ["get", "org.gnome.shell", "enabled-extensions"]).catch(() => undefined)
  if (listed === undefined) return undefined
  const off = await context.run(gsettings, ["get", "org.gnome.shell", "disable-user-extensions"]).catch(() => "false")
  const tool = await context.program("gnome-extensions")
  return { gsettings, tool, listed, enabled: listed.includes(`'${GNOME_HELPER}'`), off: off.trim() === "true", editable: Boolean(tool) || !/["\\]/.test(listed) }
}

/** The printed list with this helper's id added at its end, every other byte as it was. */
export function withExtension(listed: string, id: string): string {
  const text = listed.trim()
  const end = text.lastIndexOf("]")
  return /^(@as\s*)?\[\s*\]$/.test(text) ? `['${id}']` : `${text.slice(0, end)}, '${id}'${text.slice(end)}`
}

/** The printed list with this helper's id cut out, every other byte as it was. */
export function withoutExtension(listed: string, id: string): string {
  const text = listed.trim()
  const cut = text.replace(`, '${id}'`, "").replace(`'${id}', `, "").replace(`'${id}'`, "")
  return /^\[\s*\]$/.test(cut) ? "@as []" : cut
}

async function setEnabled(context: DesktopGrantContext, settings: ExtensionSettings, enabled: boolean): Promise<void> {
  if (settings.enabled === enabled) return
  if (settings.tool) {
    await context.run(settings.tool, [enabled ? "enable" : "disable", GNOME_HELPER])
    return
  }
  if (!settings.editable) throw new Error("GNOME's extension list holds an entry Mako won't rewrite; nothing was changed.")
  await context.run(settings.gsettings, ["set", "org.gnome.shell", "enabled-extensions", enabled ? withExtension(settings.listed, GNOME_HELPER) : withoutExtension(settings.listed, GNOME_HELPER)])
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

async function helperInstalled(context: DesktopGrantContext, shipped: Map<string, string> | undefined): Promise<boolean> {
  if (!shipped) return false
  const same = await Promise.all(Array.from(shipped, async ([name, text]) => (await readFile(join(helperFolder(context), name), "utf8").catch(() => undefined)) === text))
  return same.every(Boolean)
}

async function gnomeHelper(context: DesktopGrantContext): Promise<MakoDesktopPermission> {
  const id = "gnome-shell-helper"
  const driver = await plainDriver(context)
  if (driver.installed && !driver.program) return { id, state: "blocked", reason: "driver-path" }
  const shipped = await shippedHelper(context)
  const settings = await extensionSettings(context)
  const installed = await helperInstalled(context, shipped)
  if (!installed || !settings?.enabled) return settings && !settings.enabled && !settings.editable ? { id, state: "blocked", reason: "extension-list" } : { id, state: "needed" }
  // Installed and enabled, and GNOME runs no user extension at all: turning them on is the person's next step.
  if (settings.off) return { id, state: "extensions-off" }
  // The Shell runs it from its next start: an older one still answering is not this one.
  const wanted = Number(/"version"\s*:\s*(\d+)/.exec(shipped?.get("metadata.json") ?? "")?.[1])
  return { id, state: (await runningHelper(context)) === wanted ? "granted" : "restart" }
}

/** Each thing this desktop asks for, with where it stands; none on X11 and wlroots, which ask for nothing. */
export async function desktopPermissions(desktop: LinuxDesktop | undefined, context: DesktopGrantContext): Promise<MakoDesktopPermission[]> {
  if (desktop?.session !== "wayland") return []
  if (desktop.compositor === "gnome") return [await gnomeHelper(context)]
  if (desktop.compositor !== "kde") return []
  const capture = await kwinCapture(context)
  return context.env.KDE_SESSION_VERSION === "5" ? [capture, { id: "pointer-input", state: "unavailable" }] : [capture]
}

/** The person's action: the one next step this desktop still needs. It says why when it can't. */
export async function grantDesktopPermissions(desktop: LinuxDesktop | undefined, context: DesktopGrantContext): Promise<void> {
  if (desktop?.session !== "wayland") return
  if (desktop.compositor === "kde") {
    const { program } = await plainDriver(context)
    if (!program) throw new Error("Mako's computer control driver isn't installed at a path KWin can match; window capture can't be allowed.")
    const folder = join(dataHome(context), "applications")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, KWIN_CAPTURE_ENTRY), kwinCaptureEntry(program), { mode: 0o644 })
    return
  }
  if (desktop.compositor !== "gnome") return
  const shipped = await shippedHelper(context)
  if (!shipped) throw new Error("This install of Mako has no Shell helper beside its computer control driver at a plain path; reinstall Mako to get it.")
  const settings = await extensionSettings(context)
  if (!settings) throw new Error("GNOME's settings (gsettings) didn't answer, so the helper can't be enabled; nothing was installed.")
  if ((await helperInstalled(context, shipped)) && settings.enabled) {
    // Installed already: what is left for the person to allow is GNOME's own switch for every user extension.
    if (settings.off) await context.run(settings.gsettings, ["set", "org.gnome.shell", "disable-user-extensions", "false"])
    return
  }
  if (!settings.enabled && !settings.editable) throw new Error("GNOME's extension list holds an entry Mako won't rewrite; nothing was installed.")
  await mkdir(helperFolder(context), { recursive: true })
  for (const [name, text] of shipped) await writeFile(join(helperFolder(context), name), text, { mode: 0o644 })
  await setEnabled(context, settings, true)
}

/** The person's action: take away what Mako put on this desktop. */
export async function revokeDesktopPermissions(desktop: LinuxDesktop | undefined, context: DesktopGrantContext): Promise<void> {
  if (desktop?.session !== "wayland") return
  if (desktop.compositor === "kde") await rm(join(dataHome(context), "applications", KWIN_CAPTURE_ENTRY), { force: true })
  if (desktop.compositor !== "gnome") return
  const settings = await extensionSettings(context)
  if (settings) await setEnabled(context, settings, false)
  await rm(helperFolder(context), { recursive: true, force: true })
}

/** Whether anything still waits on the person: their action, their next login, or something only they can change. */
export function desktopPermissionsPending(permissions: MakoDesktopPermission[]): boolean {
  return permissions.some((permission) => permission.state !== "granted" && permission.state !== "unavailable")
}
