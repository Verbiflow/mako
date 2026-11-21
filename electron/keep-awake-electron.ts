import { app, powerMonitor, powerSaveBlocker } from "electron"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

/**
 * The installed app run by its host with `--keep-awake` on Windows: the power helper `KeepAwake` drives
 * (`packages/host/src/conversations/keep-awake.ts`), speaking the Mac helper's lines (`native/sleep-watch-macos`) on
 * stdin and stdout. The host runs as Node and has no `powerSaveBlocker`; this process is Electron's app and does.
 *
 *   in:  `hold idle <name>`, `hold lid <name>`, `release`
 *   out: `power ac` or `power battery -1` (Electron can't read the charge), then on each change; `holding` once a hold
 *        is taken, `failed <reason>` when it couldn't be
 *
 * Windows has no hold for a closed lid: its power plan decides that, so `lid` holds what `idle` does. The hold ends
 * with this process, and this process ends when its host closes stdin or goes, so a host that's gone holds nothing.
 */
export function runKeepAwakeHelper(): void {
  let blocker: number | undefined
  const say = (line: string) => process.stdout.write(`${line}\n`)
  const power = () => say(powerMonitor.isOnBatteryPower() ? "power battery -1" : "power ac")
  const release = () => {
    if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
    blocker = undefined
  }
  // No window, no taskbar button, nothing to quit when none is open.
  app.on("window-all-closed", () => undefined)
  void app.whenReady().then(() => {
    powerMonitor.on("on-ac", power)
    powerMonitor.on("on-battery", power)
    power()
    // Read through the file system rather than `process.stdin`: Electron's main process on Windows never delivers a
    // piped stdin's data to the socket Node makes of it, only its end.
    const lines = createInterface({ input: createReadStream("", { fd: 0, autoClose: false }) })
    lines.on("line", (line) => {
      const [word, kind] = line.trim().split(" ")
      if (word === "release") release()
      else if (word === "hold" && (kind === "idle" || kind === "lid")) {
        try {
          // Keeps the system from sleeping for idleness (`SetThreadExecutionState`); the screen may still turn off.
          blocker ??= powerSaveBlocker.start("prevent-app-suspension")
          say("holding")
        } catch (error) {
          say(`failed ${error instanceof Error ? error.message.replace(/\s+/g, "-").slice(0, 80) : "unknown"}`)
        }
      }
    })
    lines.on("close", () => {
      release()
      app.exit(0)
    })
  })
}
