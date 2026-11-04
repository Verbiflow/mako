// Regrades a live run's results.jsonl with the cases as they stand: a
// routing-on sample's shell counts only the commands routing would let run.
//   npx tsx --tsconfig tsconfig.app.json scripts/eval-orch-tools/regrade.ts <results.jsonl>...
import { readFileSync, writeFileSync } from "node:fs"
import { z } from "zod"
import { routeShellCall } from "@mako/host/contracts/native-calls"
import { caseCallThread, grade, loadCases, ToolArgs } from "./cases.ts"

const Sample = z.object({ steps: z.array(z.array(z.object({ tool: z.string(), args: ToolArgs }))), shell: z.array(z.string()), text: z.string(), ended: z.boolean() }).loose()
const Result = z.object({ id: z.string(), routing: z.enum(["on", "off"]), passes: z.array(z.boolean()), failures: z.array(z.array(z.string())), samples: z.array(Sample).optional(), error: z.string().optional() }).loose()

const cases = new Map(loadCases().map((orchCase) => [orchCase.id, orchCase]))
for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim())
  const regraded = lines.map((line) => {
    const result = Result.parse(JSON.parse(line))
    const orchCase = cases.get(result.id)
    if (!orchCase || result.error || !result.samples?.length) return result
    const failures = result.samples.map((sample) => {
      const thread = caseCallThread(orchCase, "/eval/project")
      const ran = result.routing === "on" ? sample.shell.filter((command) => routeShellCall(thread, { command, cwd: "/eval/project" }).kind !== "deny") : sample.shell
      return grade(orchCase, { ...sample, ran })
    })
    return { ...result, failures, passes: failures.map((failed) => !failed.length) }
  })
  writeFileSync(file.replace(/\.jsonl$/, ".regraded.jsonl"), regraded.map((result) => JSON.stringify(result)).join("\n") + "\n")
  console.log(`${file}: ${regraded.filter((result) => result.passes.length && result.passes.every(Boolean)).length}/${regraded.length} pass`)
}
