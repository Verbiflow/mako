import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

// Settings › Storage from `scripts/storage-check.html` (src/dev/storage-check.tsx), light and dark: the parts as
// measured, the line Free up space leaves, and the warning on a disk under the line. The fixture is built once and
// opened from disk by a headless Chromium, which checks what each must say and writes the screenshots into <out>;
// no port is taken.
//
//   CHROMIUM_EXECUTABLE=<chromium> node scripts/storage-ui-screenshots.mjs <out>
const run = promisify(execFile)
const executable =
  process.env.CHROMIUM_EXECUTABLE ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium")
if (!existsSync(executable)) throw new Error(`No Chromium at ${executable}; set CHROMIUM_EXECUTABLE`)

const out = resolve(process.argv[2] ?? "storage-screenshots")
const work = await mkdtemp(join(tmpdir(), "mako-storage-shots-"))
try {
  // The mock bridge is in development builds only (`main.tsx`).
  process.env.NODE_ENV = "development"
  const { build } = await import("vite")
  const built = join(work, "build")
  await build({ mode: "development", logLevel: "warn", base: "./", build: { outDir: built, emptyOutDir: true, minify: false, rollupOptions: { input: resolve("scripts/storage-check.html") } } })
  await mkdir(out, { recursive: true })
  const page = pathToFileURL(join(built, "scripts", "storage-check.html")).href
  const chromium = (query, ...flags) =>
    run(
      executable,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        `--user-data-dir=${join(work, "profile")}`,
        "--window-size=768,3000",
        "--virtual-time-budget=10000",
        ...flags,
        `${page}?${query}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    )
  const shot = async (name, query, check) => {
    const { stdout } = await chromium(query, "--dump-dom")
    check(stdout.replace(/<(style|script)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "))
    await chromium(query, "--force-device-scale-factor=2", `--screenshot=${join(out, name)}`)
    assert.ok(existsSync(join(out, name)), `${name} was written`)
  }
  for (const theme of ["light", "dark"]) {
    await shot(`disk-budget-storage-${theme}.png`, `theme=${theme}`, (text) => {
      assert.match(text, /Cursor agents/)
      assert.match(text, /Collected by Mako/)
      assert.match(text, /\d+\.\d GB free of 926 GB/)
      assert.doesNotMatch(text, /Under 30\.0 GB free\. Mako frees/, "a disk with room isn't warned about")
      assert.match(text, /Safe to remove now .*Needs your OK .*Kept/, "each class, with its total")
      assert.match(text, /Biggest Threads .*phone-open-2/)
      assert.match(text, /Freed 14\.2 GB when the disk ran low/)
      assert.match(text, /Free space when the disk runs low/)
    })
    await shot(`storage-now-preview-${theme}.png`, `theme=${theme}&open=now`, (text) => {
      assert.match(text, /queue-rules .*The Fin finished and has been quiet for 3 days/, "the preview says exactly what goes, and why")
      assert.match(text, /Remove 35\.4 GB/)
    })
    await shot(`storage-approve-confirm-${theme}.png`, `theme=${theme}&open=approve&confirm`, (text) => {
      assert.match(text, /Remove 6 folders \(98\.6 GB\)/, "the confirmation names the count and the size")
    })
    await shot(`storage-keep-${theme}.png`, `theme=${theme}&open=keep`, (text) => {
      assert.match(text, /uncommitted changes/)
    })
    await shot(`disk-budget-storage-freed-${theme}.png`, `theme=${theme}&free`, (text) => {
      assert.match(text, /Cursor agents: freed .* when you asked/)
    })
    await shot(`disk-budget-storage-low-${theme}.png`, `theme=${theme}&storage=low`, (text) => {
      assert.match(text, /Under 30\.0 GB free/)
    })
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
console.log(`Storage screenshots: ${out}`)
