import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { MachineOffer } from "./contracts/machine-offer.js"
import { nodePlatform } from "./platform.js"

/**
 * What a person sitting at the host's machine sees: its file manager, its
 * default apps, its clipboard and its folder picker, through the system's own
 * commands, so the host needs no window toolkit for them. What the machine
 * offers is probed, not assumed from its platform: a Linux desktop has a file
 * manager, a Linux server has no screen at all. A machine nobody sits at, such
 * as a cloud host, says so as a value rather than failing somewhere inside.
 *
 * Only local clients reach these: the gateway exposes none of the calls that
 * use them, so a person on another device never opens a window on this one.
 * Each client answers links, the clipboard and notifications itself
 * (`contracts/client-calls.ts`), and clients hide what {@link Machine.offer}
 * leaves out.
 */
export interface Machine {
  readonly kind: "present"
  /** What this machine offers, probed once. An action it leaves out is refused with its reason. */
  offer(): Promise<MachineOffer>
  /** Shows a file or folder in the file manager, selected where the file manager can. */
  reveal(path: string): Promise<void>
  /** Opens a file or folder in its default app, or in `app`. Resolves false when nothing could open it. */
  open(path: string, app?: string): Promise<boolean>
  /** Opens an address in the default browser, or the app registered for its scheme. */
  openUrl(url: string): Promise<void>
  copy(text: string): Promise<void>
  /** The folder the person picks, or null if they cancel. */
  chooseFolder(prompt: string): Promise<string | null>
  /** The default browser's application path, when the machine says. */
  defaultBrowser(): Promise<string | undefined>
  /** A PNG rendering of a document, at most `size` pixels on its longer side, or null if the system can't render it. */
  thumbnail(path: string, size: number): Promise<Buffer | null>
}

export interface AbsentMachine {
  readonly kind: "absent"
  readonly reason: string
}

export type MachineCapability = Machine | AbsentMachine

/** A machine action asked of a host that has no person at its machine, or a machine without that action. */
export class MachineAbsentError extends Error {}

export interface CommandResult {
  code: number
  stdout: string
}

export interface CommandOptions {
  input?: string
  /** How long the command may take; the default suits commands that return at once. */
  timeoutMs?: number
}

/**
 * Runs a system command. A non-zero exit resolves, as some commands use it for
 * "cancelled"; a command that can't start or runs out of time rejects.
 */
export type RunCommand = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

/** Whether an executable of this name is on the machine's `PATH`. */
export type FindCommand = (command: string) => Promise<boolean>

const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: options.timeoutMs ?? 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error && !Number.isInteger(error.code)) reject(error)
      else resolve({ code: error ? Number(error.code) : 0, stdout })
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })

export function commandsOnPath(env: NodeJS.ProcessEnv): FindCommand {
  const found = new Map<string, Promise<boolean>>()
  const directories = (env.PATH ?? "").split(delimiter).filter(Boolean)
  const search = async (command: string) => {
    for (const directory of directories) {
      if (await access(join(directory, command), constants.X_OK).then(() => true, () => false)) return true
    }
    return false
  }
  return (command) => {
    let answer = found.get(command)
    if (!answer) found.set(command, (answer = search(command)))
    return answer
  }
}

async function succeed(run: RunCommand, command: string, args: string[], options?: CommandOptions): Promise<string> {
  const result = await run(command, args, options)
  if (result.code !== 0) throw new Error(`${command} ${args[0] ?? ""} failed with exit code ${result.code}`)
  return result.stdout
}

const DEFAULT_BROWSER = [
  'ObjC.import("AppKit")',
  'const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"))',
  'app ? app.path.js : ""',
].join(";")

const MAC_OFFER: MachineOffer = { fileManager: "finder", chooseFolder: true }

/** The Mac's own commands: `open`, `pbcopy`, AppleScript's folder chooser, Quick Look and AppKit through JXA. */
export function macMachine(run: RunCommand = runCommand): Machine {
  let browser: Promise<string | undefined> | undefined
  return {
    kind: "present",
    offer: async () => MAC_OFFER,
    reveal: async (path) => { await succeed(run, "open", ["-R", path]) },
    open: async (path, app) => (await run("open", app ? ["-a", app, path] : [path])).code === 0,
    openUrl: async (url) => { await succeed(run, "open", [url]) },
    copy: async (text) => { await succeed(run, "pbcopy", [], { input: text }) },
    chooseFolder: async (prompt) => {
      // -128 is AppleScript's "user cancelled"; osascript exits 1 for it.
      const result = await run(
        "osascript",
        ["-e", "on run argv", "-e", "POSIX path of (choose folder with prompt (item 1 of argv))", "-e", "end run", prompt],
        { timeoutMs: 30 * 60_000 }
      )
      if (result.code !== 0) return null
      const path = result.stdout.trim()
      return path.length > 1 ? path.replace(/\/$/, "") : path
    },
    defaultBrowser: () =>
      (browser ??= succeed(run, "osascript", ["-l", "JavaScript", "-e", DEFAULT_BROWSER])
        .then((path) => path.trim() || undefined)
        .catch(() => undefined)),
    thumbnail: async (path, size) => {
      // Quick Look waits indefinitely on a path that isn't a file, and a thumbnail is never worth waiting long for.
      if (!(await stat(path).then((info) => info.isFile(), () => false))) return null
      const folder = await mkdtemp(join(tmpdir(), "mako-thumbnail-"))
      try {
        const result = await run("qlmanage", ["-t", "-s", String(size), "-o", folder, path], { timeoutMs: 10_000 }).catch(() => null)
        if (result?.code !== 0) return null
        return await readFile(join(folder, `${basename(path)}.png`)).catch(() => null)
      } finally {
        await rm(folder, { recursive: true, force: true })
      }
    },
  }
}

/** A string in GVariant's text form, as `gdbus call` reads its arguments. */
function gvariantString(value: string): string {
  return `'${value.replace(/[\\']/g, (character) => `\\${character}`)}'`
}

export function hasGraphicalSession(env: NodeJS.ProcessEnv): boolean {
  return [env.DISPLAY, env.WAYLAND_DISPLAY].some((value) => value !== undefined && value.trim().length > 0)
}

export interface LinuxMachineInput {
  env: NodeJS.ProcessEnv
  run?: RunCommand
  find?: FindCommand
}

/**
 * A Linux desktop's own commands: `xdg-open`, the file manager over D-Bus,
 * `zenity` or `kdialog` for the folder chooser, and `wl-copy`, `xclip` or
 * `xsel` for the clipboard. Each is offered only when it's there. A session
 * variable and `xdg-open` alone don't prove a folder opens: without an
 * `inode/directory` handler `xdg-open` exits after its launcher detaches and
 * nothing appears, so the file manager is offered only with a handler.
 */
export function linuxMachine({ env, run = runCommand, find = commandsOnPath(env) }: LinuxMachineInput): Machine {
  let probed: Promise<MachineOffer> | undefined
  const folderHandler = async () =>
    (await find("xdg-open")) && (await find("xdg-mime")) &&
    (await run("xdg-mime", ["query", "default", "inode/directory"], { timeoutMs: 2_000 }).then(
      (result) => result.code === 0 && result.stdout.trim().length > 0,
      () => false
    ))
  const chooser = async () => (await find("zenity")) ? "zenity" : (await find("kdialog")) ? "kdialog" : null
  const clipboard = async () =>
    env.WAYLAND_DISPLAY && (await find("wl-copy")) ? (["wl-copy", []] as const)
      : (await find("xclip")) ? (["xclip", ["-selection", "clipboard"]] as const)
      : (await find("xsel")) ? (["xsel", ["--clipboard", "--input"]] as const)
      : null
  const offer = () => (probed ??= (async (): Promise<MachineOffer> => {
    const [fileManager, folder] = await Promise.all([folderHandler(), chooser()])
    const missing = [
      fileManager ? null : "no file manager is set to open folders (xdg-mime query default inode/directory)",
      folder ? null : "no folder chooser is installed (zenity or kdialog)",
    ].filter((part) => part !== null)
    const offered: MachineOffer = { fileManager: fileManager ? "file-manager" : null, chooseFolder: folder !== null }
    if (missing.length) offered.missing = `On this machine, ${missing.join(", and ")}.`
    return offered
  })())
  const refuse = async (): Promise<never> => {
    throw new MachineAbsentError((await offer()).missing ?? "This machine can't do that.")
  }
  const xdgOpen = async (target: string) => (await run("xdg-open", [target])).code === 0
  return {
    kind: "present",
    offer,
    async reveal(path) {
      if (!(await offer()).fileManager) return refuse()
      // FileManager1 selects the item in Nautilus, Dolphin, Nemo and others; without it the folder opens.
      if (await find("gdbus")) {
        const shown = await run("gdbus", [
          "call", "--session", "--dest", "org.freedesktop.FileManager1",
          "--object-path", "/org/freedesktop/FileManager1",
          "--method", "org.freedesktop.FileManager1.ShowItems",
          `[${gvariantString(pathToFileURL(path).href)}]`, "''",
        ], { timeoutMs: 5_000 }).catch(() => null)
        if (shown?.code === 0) return
      }
      const folder = await stat(path).then((info) => (info.isDirectory() ? path : dirname(path)), () => dirname(path))
      if (!(await xdgOpen(folder))) throw new Error(`xdg-open couldn't show ${folder}`)
    },
    open: async (path, app) => (app ? (await run(app, [path])).code === 0 : xdgOpen(path)),
    async openUrl(url) {
      if (!(await find("xdg-open"))) throw new MachineAbsentError("This machine has no xdg-open to open links with.")
      if (!(await xdgOpen(url))) throw new Error(`xdg-open couldn't open ${url}`)
    },
    async copy(text) {
      const command = await clipboard()
      if (!command) throw new MachineAbsentError("This machine has no clipboard command (wl-copy, xclip or xsel).")
      await succeed(run, command[0], [...command[1]], { input: text })
    },
    async chooseFolder(prompt) {
      const command = await chooser()
      if (!command) return refuse()
      const result = await run(
        command,
        command === "zenity" ? ["--file-selection", "--directory", `--title=${prompt}`] : ["--getexistingdirectory", env.HOME ?? "/", "--title", prompt],
        { timeoutMs: 30 * 60_000 }
      )
      // Both exit 1 when the person cancels.
      if (result.code !== 0) return null
      return result.stdout.trim() || null
    },
    defaultBrowser: async () => undefined,
    thumbnail: async () => null,
  }
}

export function absentMachine(reason: string): AbsentMachine {
  return { kind: "absent", reason }
}

export interface MachineProbe {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  run?: RunCommand
  find?: FindCommand
}

/** The machine this host runs on, by what it has: a Mac, a Linux desktop session, or no screen at all. */
export function probeMachine({ platform, env, run, find }: MachineProbe): MachineCapability {
  if (platform === "darwin") return macMachine(run)
  if (platform === "linux") {
    return hasGraphicalSession(env)
      ? linuxMachine({ env, run, find })
      : absentMachine("This machine has no graphical session (no DISPLAY or WAYLAND_DISPLAY), so Mako can't open or show anything on it.")
  }
  return absentMachine(`Mako doesn't open or show anything on ${platform} yet.`)
}

/** What a machine offers clients; an absent one offers nothing, and says why. */
export async function machineOffer(capability: MachineCapability): Promise<MachineOffer> {
  return capability.kind === "present"
    ? capability.offer()
    : { fileManager: null, chooseFolder: false, missing: capability.reason }
}

let machine: MachineCapability | undefined

/** This host's machine, probed once. */
export function hostMachine(): MachineCapability {
  machine ??= probeMachine({ platform: nodePlatform(), env: process.env })
  return machine
}

/** This host's machine, for a call a person made at it; refused with the machine's reason where there is none. */
export function presentMachine(capability = hostMachine()): Machine {
  if (capability.kind === "absent") throw new MachineAbsentError(capability.reason)
  return capability
}
