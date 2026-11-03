import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

// Settings › Simulators from `scripts/simulators-check.html` (src/dev/simulators-check.tsx), light and dark, at every
// step a Mac meets: only the Command Line Tools, waiting for Xcode, too little disk, Xcode to finish (and its password
// prompt closed), the runtime downloading, the simulators to make, ready, broken, and off macOS. The fixture is built
// once and opened from disk by a headless Chromium, which checks what each must say and writes the screenshots into
// <out>; no port is taken. Then the desk's simulator panel from `scripts/simulator-panel-check.html` against a fake
// stream: a Thread driving the iPhone, the person driving it, the iPad, and no simulator yet.
//
//   CHROMIUM_EXECUTABLE=<chromium> node scripts/simulators-ui-screenshots.mjs [<out>]
const run = promisify(execFile)
const executable =
  process.env.CHROMIUM_EXECUTABLE ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium")
if (!existsSync(executable)) throw new Error(`No Chromium at ${executable}; set CHROMIUM_EXECUTABLE`)

const out = resolve(process.argv[2] ?? join(tmpdir(), "mako-simulators-screenshots"))
const work = await mkdtemp(join(tmpdir(), "mako-simulators-shots-"))
const SCENARIOS = {
  clt: [/Set up iPhone and iPad simulators/, /Get Xcode/, /Free from the App Store with your Apple ID/, /193 GB/, /Install the simulator tools/, /serve-sim 0\.1\.48/],
  waiting: [/Setting up simulators/, /Waiting for Xcode from the App Store/, /Open App Store/],
  "low-disk": [/this Mac has 18 GB/],
  finish: [/Xcode 26\.1/, /Finish Xcode's setup/, /administrator's password; Mako never sees it/],
  "prompt-closed": [/The password prompt was closed/],
  downloading: [/Downloading iOS 26\.1: 3\.16 GB of 7\.35 GB/, /43%/],
  make: [/Make an iPhone and an iPad/, /Mako iPhone 17 Pro and Mako iPad Pro 13-inch \(M5\)/],
  ready: [/Simulators are ready/, /Healthy/, /iPhone 17 Pro and iPad Pro 13-inch \(M5\) on iOS 26\.1/, /Check again/],
  broken: [/Simulators need a repair/, /The iOS runtime isn't installed any more/, /Repair/],
  unavailable: [/run on a Mac with Xcode/],
}
try {
  // The mock bridge is in development builds only (`main.tsx`).
  process.env.NODE_ENV = "development"
  const { build } = await import("vite")
  const built = join(work, "build")
  await build({ mode: "development", logLevel: "warn", base: "./", build: { outDir: built, emptyOutDir: true, minify: false, rollupOptions: { input: { settings: resolve("scripts/simulators-check.html"), panel: resolve("scripts/simulator-panel-check.html") } } } })
  await mkdir(out, { recursive: true })
  const pages = { settings: pathToFileURL(join(built, "scripts", "simulators-check.html")).href, panel: pathToFileURL(join(built, "scripts", "simulator-panel-check.html")).href }
  const chromium = (page, size, query, ...flags) =>
    run(
      executable,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        `--user-data-dir=${join(work, "profile")}`,
        `--window-size=${size}`,
        "--virtual-time-budget=10000",
        ...flags,
        `${page}?${query}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    )
  const shot = async (name, query, expected, page = pages.settings, size = "768,1080") => {
    const { stdout } = await chromium(page, size, query, "--dump-dom")
    const text = stdout.replace(/<(style|script)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ")
    for (const pattern of expected) assert.match(text, pattern, `${name} says ${pattern}`)
    await chromium(page, size, query, "--force-device-scale-factor=2", `--screenshot=${join(out, name)}`)
    assert.ok(existsSync(join(out, name)), `${name} was written`)
  }
  for (const theme of ["light", "dark"]) {
    for (const [scenario, expected] of Object.entries(SCENARIOS)) await shot(`devices-settings-${scenario}-${theme}.png`, `mock&theme=${theme}&simulators=${scenario}`, expected)
    await shot(`devices-settings-ready-details-${theme}.png`, `mock&theme=${theme}&simulators=ready&details`, [/Developer folder/, /5D1C8E52/, /serve-sim 0\.1\.48 \(Apache-2\.0\)/])
    await shot(`devices-panel-agent-${theme}.png`, `mock&theme=${theme}&panel=agent`, [/Stand-in, not iOS/, /iPhone 17 Pro · WebKit 26\.0 at iPhone size/, /“Fix the jump when a reply streams” is driving it\. You're watching\./, /Take over/], pages.panel, "440,900")
    await shot(`devices-panel-person-${theme}.png`, `mock&theme=${theme}&panel=person`, [/You're driving it/, /Hand back/], pages.panel, "440,900")
    await shot(`devices-panel-tablet-${theme}.png`, `mock&theme=${theme}&panel=idle&form=tablet&width=760&height=900`, [/iPad Pro 13-inch \(M5\) · WebKit 26\.0 at iPad size/, /Nobody is driving it/, /Open/], pages.panel, "760,900")
    await shot(`devices-panel-none-${theme}.png`, `mock&theme=${theme}&panel=none`, [/No simulator yet/, /This Mac has no Xcode/, /Set up simulators/], pages.panel, "440,900")
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
console.log(`Simulators screenshots: ${out}`)
