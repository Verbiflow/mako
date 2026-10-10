import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { absentMachine, commandsOnPath, linuxMachine, macMachine, MachineAbsentError, machineOffer, presentMachine, probeMachine, type CommandResult, type RunCommand } from "../electron/machine.ts"

/**
 * The Machine capability: the commands the Mac's implementation runs, checked
 * without opening Finder, a browser or a dialog, or touching the clipboard;
 * the read-only parts against the real Mac; and the absent machine's refusal.
 */
const calls: Array<[string, string[], string | undefined]> = []
let exit = 0
let stdout = ""
const record: RunCommand = async (command, args, options) => {
  calls.push([command, args, options?.input])
  return { code: exit, stdout }
}
const mac = macMachine(record)

await mac.reveal("/tmp/a file")
assert.deepEqual(calls.pop(), ["open", ["-R", "/tmp/a file"], undefined], "Reveal selects the item in Finder")
assert.equal(await mac.open("/tmp/doc.pdf"), true)
assert.deepEqual(calls.pop(), ["open", ["/tmp/doc.pdf"], undefined], "Open uses the default app")
assert.equal(await mac.open("/tmp/doc.pdf", "Preview"), true)
assert.deepEqual(calls.pop(), ["open", ["-a", "Preview", "/tmp/doc.pdf"], undefined], "Open with an app names it")
await mac.openUrl("https://example.com/?q=1")
assert.deepEqual(calls.pop(), ["open", ["https://example.com/?q=1"], undefined])
await mac.copy("copied text")
assert.deepEqual(calls.pop(), ["pbcopy", [], "copied text"], "Copy writes the text to pbcopy's input, never to its arguments")

stdout = "/Users/someone/Projects/app/\n"
const prompt = 'Choose "a" folder\\'
assert.equal(await mac.chooseFolder(prompt), "/Users/someone/Projects/app", "The chosen folder comes back without AppleScript's trailing slash")
const chooser = calls.pop()
assert.equal(chooser?.[1].at(-1), prompt, "The prompt is an argument to the script, never spliced into its source")
assert.ok(!chooser?.[1].slice(0, -1).some((part) => part.includes(prompt)))

exit = 1
assert.equal(await mac.open("/tmp/nothing-opens-this"), false, "Open says when nothing could open the item")
assert.equal(await mac.chooseFolder("Choose a folder"), null, "Cancelling the chooser is no folder, not an error")
await assert.rejects(mac.reveal("/tmp/a"), /open -R failed with exit code 1/)
await assert.rejects(mac.openUrl("https://example.com"), /open https:\/\/example.com failed/)
await assert.rejects(mac.copy("x"), /pbcopy/)
calls.length = 0

const absent = absentMachine("This machine has no screen a person is watching, so Mako can't open or show anything on it.")
assert.throws(() => presentMachine(absent), (error: Error) =>
  error instanceof MachineAbsentError && error.message === absent.reason)
assert.equal(presentMachine(mac), mac)
assert.deepEqual(await mac.offer(), { fileManager: "finder", chooseFolder: true }, "A Mac offers Finder and its folder chooser")
assert.deepEqual(await machineOffer(absent), { fileManager: null, chooseFolder: false, missing: absent.reason }, "An absent machine offers nothing and says why")

// Probed, not assumed from the platform.
const display = { DISPLAY: ":0", PATH: "/usr/bin" }
assert.equal(probeMachine({ platform: "darwin", env: {} }).kind, "present")
const server = probeMachine({ platform: "linux", env: { PATH: "/usr/bin" } })
assert.equal(server.kind, "absent", "A Linux machine without a graphical session has no screen")
assert.match(server.kind === "absent" ? server.reason : "", /no graphical session/)
assert.equal(probeMachine({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }).kind, "present", "Wayland is a graphical session")
assert.equal(probeMachine({ platform: "linux", env: { DISPLAY: "  " } }).kind, "absent", "A blank DISPLAY is none")
assert.equal(probeMachine({ platform: "win32", env: {} }).kind, "absent")

/** A Linux desktop with the given commands on PATH, recording what it runs. */
function linuxWith(commands: string[], answers: Record<string, CommandResult> = {}, env: NodeJS.ProcessEnv = display) {
  const ran: Array<[string, string[], string | undefined]> = []
  const machine = linuxMachine({
    env,
    find: async (command) => commands.includes(command),
    run: async (command, args, options) => {
      ran.push([command, args, options?.input])
      return answers[command] ?? { code: 0, stdout: "" }
    },
  })
  return { machine, ran }
}

const full = linuxWith(["xdg-open", "xdg-mime", "zenity", "gdbus", "xclip"], { "xdg-mime": { code: 0, stdout: "org.gnome.Nautilus.desktop\n" } })
assert.deepEqual(await full.machine.offer(), { fileManager: "file-manager", chooseFolder: true }, "A full Linux desktop offers its file manager and a chooser")
await full.machine.reveal("/tmp/it's here.txt")
const shown = full.ran.at(-1)
assert.equal(shown?.[0], "gdbus", "Reveal asks the file manager over D-Bus to select the item")
assert.ok(shown?.[1].includes("org.freedesktop.FileManager1.ShowItems"))
assert.equal(shown?.[1].at(-2), "['file:///tmp/it\\'s%20here.txt']", "The path goes as a file URI, its quote escaped for GVariant")
await full.machine.copy("copied text")
assert.deepEqual(full.ran.at(-1), ["xclip", ["-selection", "clipboard"], "copied text"], "Copy writes to xclip's input, never its arguments")
await full.machine.openUrl("https://example.com")
assert.deepEqual(full.ran.at(-1), ["xdg-open", ["https://example.com"], undefined])

const zenity = linuxWith(["xdg-open", "xdg-mime", "zenity"], { "xdg-mime": { code: 0, stdout: "x.desktop\n" }, zenity: { code: 0, stdout: "/home/someone/project\n" } })
assert.equal(await zenity.machine.chooseFolder("Choose a folder"), "/home/someone/project")
assert.deepEqual(zenity.ran.at(-1)?.[1], ["--file-selection", "--directory", "--title=Choose a folder"])
const folder = await mkdtemp(join(tmpdir(), "mako-machine-reveal-"))
await zenity.machine.reveal(join(folder, "file.txt"))
assert.deepEqual(zenity.ran.at(-1), ["xdg-open", [folder], undefined], "Without D-Bus, reveal opens the containing folder")
await rm(folder, { recursive: true, force: true })

const bare = linuxWith(["xdg-open"], {}, { WAYLAND_DISPLAY: "wayland-0" })
const bareOffer = await bare.machine.offer()
assert.equal(bareOffer.fileManager, null, "xdg-open alone doesn't prove a folder opens: no inode/directory handler is known")
assert.equal(bareOffer.chooseFolder, false)
assert.equal(bareOffer.missing, "On this machine, no file manager is set to open folders (xdg-mime query default inode/directory), and no folder chooser is installed (zenity or kdialog).")
await assert.rejects(bare.machine.reveal("/tmp/a"), (error: Error) => error instanceof MachineAbsentError && error.message === bareOffer.missing, "Reveal is refused with the offer's reason")
await assert.rejects(bare.machine.chooseFolder("Choose"), MachineAbsentError)
await assert.rejects(bare.machine.copy("x"), /no clipboard command/)

const noHandler = linuxWith(["xdg-open", "xdg-mime", "kdialog"], { "xdg-mime": { code: 0, stdout: "\n" } })
assert.deepEqual(await noHandler.machine.offer(), {
  fileManager: null,
  chooseFolder: true,
  missing: "On this machine, no file manager is set to open folders (xdg-mime query default inode/directory).",
}, "An empty handler is no file manager; kdialog is a chooser")
const wayland = linuxWith(["wl-copy", "xclip"], {}, { WAYLAND_DISPLAY: "wayland-0" })
await wayland.machine.copy("x")
assert.equal(wayland.ran.at(-1)?.[0], "wl-copy", "Wayland copies with wl-copy")

const path = await mkdtemp(join(tmpdir(), "mako-machine-path-"))
try {
  await writeFile(join(path, "runnable"), "#!/bin/sh\n", { mode: 0o755 })
  await writeFile(join(path, "plain"), "", { mode: 0o644 })
  const find = commandsOnPath({ PATH: `/nonexistent${delimiter}${path}` })
  assert.equal(await find("runnable"), true, "An executable on PATH is found")
  assert.equal(await find("plain"), false, "A file that can't run is not a command")
  assert.equal(await find("missing"), false)
} finally {
  await rm(path, { recursive: true, force: true })
}

if (process.platform === "darwin") {
  const real = macMachine()
  const browser = await real.defaultBrowser()
  assert.ok(browser === undefined || browser.endsWith(".app"), `The default browser is an application: ${browser}`)
  assert.equal(await real.defaultBrowser(), browser, "The default browser is asked once")
  const folder = await mkdtemp(join(tmpdir(), "mako-machine-"))
  try {
    const sheet = join(folder, "sheet.csv")
    await writeFile(sheet, "name,count\nalpha,1\nbeta,2\n")
    const png = await real.thumbnail(sheet, 300)
    assert.ok(png, "Quick Look renders a spreadsheet")
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], "The thumbnail is a PNG")
    assert.ok(png.readUInt32BE(16) <= 300 && png.readUInt32BE(20) <= 300, "The thumbnail fits the size asked for")
    assert.equal(await real.thumbnail(join(folder, "missing.xlsx"), 300), null, "A file Quick Look can't render has no thumbnail")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

console.log("Machine: the Mac's reveal, open, open with, links, copy and folder chooser commands, cancellation and failures, the absent machine's refusal, " +
  "what each machine offers clients, probing by graphical session rather than platform, and a Linux desktop's D-Bus reveal, folder fallback, choosers and clipboards, each offered only when present" +
  (process.platform === "darwin" ? ", and the real default browser and Quick Look thumbnails" : "") + " passed")
