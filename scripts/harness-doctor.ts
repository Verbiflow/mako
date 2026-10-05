import { parseArgs } from "node:util"
import { z } from "zod"
import {
  defaultDataDir,
  doctorReport,
  formatReport,
  harnessIds,
} from "./harness-doctor-report.ts"

/**
 * One harness's health as this machine sees it, from local files only:
 * nothing starts a session, spends usage or writes a file.
 *
 *   npm run harness:doctor                      every harness
 *   npm run harness:doctor -- codex             one harness
 *   npm run harness:doctor -- codex --json      one machine-readable object
 *   npm run harness:doctor -- --days 30 --data-dir ~/Library/Application\ Support/mako-dev
 *
 * The data directory defaults to the installed app's (`MAKO_DATA_ROOT` and
 * `MAKO_PROFILE` move it as they move the app's). Installed versions come
 * from `<cli> --version` or the SDK's package, never from a turn.
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    "data-dir": { type: "string" },
    days: { type: "string", default: "7" },
  },
})

const harness = positionals[0]
if (harness && !harnessIds().includes(harness)) {
  console.error(`No harness named ${harness}. Harnesses: ${harnessIds().join(", ")}`)
  process.exit(2)
}
const days = z.coerce.number().int().positive().safeParse(options.days)
if (!days.success) {
  console.error("--days takes a whole number of days, such as 7")
  process.exit(2)
}

const report = await doctorReport({ dataDir: options["data-dir"] ?? defaultDataDir(), days: days.data, harness })
console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report))
