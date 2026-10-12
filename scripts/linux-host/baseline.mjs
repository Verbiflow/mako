import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

/**
 * The Linux host's numbers against a recorded run of the same measurement,
 * runtime/host/baseline.json, so a change that moves them shows in the job
 * summary. There is no cutoff: hosted runners differ run to run, and the
 * table names both machines.
 *
 *   node scripts/linux-host/baseline.mjs compare <evidence>   the table, also into $GITHUB_STEP_SUMMARY
 *   node scripts/linux-host/baseline.mjs record <evidence> --run <url>   replace the baseline
 *
 * `<evidence>` is a run's evidence directory (scripts/test-host-linux.mjs
 * --measure), as the host-linux-x64 workflow uploads it.
 */
const BASELINE = new URL("../../runtime/host/baseline.json", import.meta.url)

const median = (values) => values?.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : undefined
const at = (path) => (measure) => path.split(".").reduce((value, key) => value?.[key], measure)

/** Every metric is better lower. */
const METRICS = [
  ["Start, first", "ms", at("startup.coldHealthMs")],
  ["Start, warm median", "ms", at("startup.warmMedianMs")],
  ["Stop", "ms", at("stopMs")],
  ["Idle host memory", "MB", at("idle.memory.hostMb")],
  ["Idle host footprint", "MB", at("idle.memory.footprintMb")],
  ["Idle footprint with children", "MB", at("idle.memory.totalFootprintMb")],
  ["Idle heap", "MB", at("idle.heapMb")],
  ["Idle CPU, median", "%", at("idle.cpuPercent.median")],
  ["Read, p50", "ms", at("reads.sequentialMs.p50")],
  ["Read, p99", "ms", at("reads.sequentialMs.p99")],
  ["200 parallel reads", "ms", at("reads.parallel.wallMs")],
  ["Session start, median of 6", "ms", (measure) => median(measure.streaming?.liveStartMs)],
  ["Launch, p50", "ms", at("streaming.startupPhasesMs.launch.p50")],
  ["Streaming host memory, peak", "MB", at("streaming.memoryPeak.hostMb")],
  ["Streaming host footprint, peak", "MB", at("streaming.memoryPeak.footprintMb")],
  ["Streaming footprint with children, peak", "MB", at("streaming.memoryPeak.totalFootprintMb")],
  ["Streaming heap", "MB", at("streaming.host.heapMb")],
  ["Streaming CPU, median", "%", at("streaming.host.cpuPercent.median")],
  ["Read while streaming, p99", "ms", at("streaming.readsDuringMs.p99")],
  ["Event loop delay while streaming, p99", "ms", at("streaming.hostLoop.delayMs.p99")],
  ["Event loop delay while streaming, max", "ms", at("streaming.hostLoop.delayMs.max")],
  ["Event loop holds over 100 ms", "", at("streaming.hostLoop.holds.count")],
]

function read(evidence) {
  const json = (name) => JSON.parse(readFileSync(join(evidence, name), "utf8"))
  const measure = json("measure.json")
  return {
    commit: json("manifest.json").commit,
    measured: measure.measured,
    runtime: measure.runtime,
    machine: `${measure.machine.cpu}, ${measure.machine.cores} cores, ${measure.machine.memoryGb} GB`,
    metrics: Object.fromEntries(METRICS.map(([name, , value]) => [name, value(measure) ?? null])),
  }
}

const { positionals: [command, evidence], values } = parseArgs({ allowPositionals: true, options: { run: { type: "string" } } })
if (!evidence || (command !== "compare" && command !== "record") || (command === "record" && !values.run)) {
  console.error("usage: baseline.mjs compare <evidence> | record <evidence> --run <url>")
  process.exit(2)
}
const current = read(evidence)

if (command === "record") {
  writeFileSync(BASELINE, `${JSON.stringify({ run: values.run, ...current }, null, 2)}\n`)
  console.log(`baseline: recorded ${current.commit.slice(0, 8)} from ${values.run}`)
} else {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"))
  const round = (value) => Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 100) / 100
  const shown = (value, unit) => value === null ? "not measured" : `${round(value)}${unit && ` ${unit}`}`
  const change = (was, now, unit) => {
    if (was === null || now === null) return ""
    const delta = round(now - was)
    const percent = was ? ` (${delta >= 0 ? "+" : ""}${Math.round((delta / was) * 100)}%)` : ""
    return `${delta >= 0 ? "+" : ""}${delta}${unit && ` ${unit}`}${percent}`
  }
  const lines = [
    "### Linux host against its baseline",
    "",
    `Baseline: ${baseline.commit.slice(0, 8)}, measured ${baseline.measured.slice(0, 10)} on ${baseline.machine} ([run](${baseline.run})), ${baseline.runtime}.`,
    `This run: ${current.commit.slice(0, 8)} on ${current.machine}, ${current.runtime}.`,
    "Lower is better throughout. Hosted runners vary, so a change of a few percent is noise; there is no cutoff.",
    "",
    "| Measure | Baseline | This run | Change |",
    "| --- | ---: | ---: | ---: |",
    ...METRICS.map(([name, unit]) => {
      const was = baseline.metrics[name] ?? null
      const now = current.metrics[name]
      return `| ${name} | ${shown(was, unit)} | ${shown(now, unit)} | ${change(was, now, unit)} |`
    }),
  ]
  const table = `${lines.join("\n")}\n`
  process.stdout.write(table)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table)
}
