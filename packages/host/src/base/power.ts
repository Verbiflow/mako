import { execFile } from "node:child_process"
import { onMac } from "./platform.js"

/** How the machine is powered, as work in the background asks before it takes more: on battery, how full, and Low Power Mode. */
export type PowerReading = { onBattery: boolean; percent: number | undefined; lowPower: boolean }

/**
 * What `pmset -g batt` and `pmset -g` say, read: the source it draws from ("Battery Power" or "AC Power"), the battery's
 * percentage, and Low Power Mode, which macOS prints as `powermode 1` (`lowpowermode 1` before macOS 14). Anything it
 * doesn't say reads as plugged in.
 */
export function parsePower(battery: string, settings: string): PowerReading {
  const percent = /(\d{1,3})%/.exec(battery)?.[1]
  return {
    onBattery: /drawing from 'Battery Power'/.test(battery),
    percent: percent === undefined ? undefined : Number(percent),
    lowPower: /^\s*(?:lowpowermode|powermode)\s+1\s*$/m.test(settings),
  }
}

function pmset(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("/usr/bin/pmset", args, { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => resolve(error ? "" : stdout))
  })
}

/** This machine's power, through macOS's own `pmset`; a machine without it (Linux, a cloud host) reads as plugged in. */
export async function readPower(): Promise<PowerReading> {
  if (!onMac()) return { onBattery: false, percent: undefined, lowPower: false }
  const [battery, settings] = await Promise.all([pmset(["-g", "batt"]), pmset(["-g"])])
  return parsePower(battery, settings)
}
