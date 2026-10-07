import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { comparePair, PAIRS_FOLDER } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"

/**
 * Every kept capture/store pair: the live wire through the live decoder and
 * the store through its history reader must draw the same, apart from the
 * differences the pair lists with a reason. Pairs are recorded from real
 * harness CLIs by `npm run harness:decode-pairs -- <harness> --write`.
 */

const failures: string[] = []
let checked = 0
for (const harness of await readdir(FIXTURE_ROOT)) {
  const root = join(FIXTURE_ROOT, harness, PAIRS_FOLDER)
  const names = await readdir(root).catch(() => [])
  for (const name of names) {
    const where = `${harness}/${PAIRS_FOLDER}/${name}`
    const { pair, unexplained, settled } = await comparePair(join(root, name))
    checked++
    const problems = [
      ...unexplained.map((difference) => `${difference.side} ${difference.line}`),
      ...pair.known.filter((difference) => !difference.reason).map((difference) => `listed without a reason: ${difference.side} ${difference.line}`),
      ...settled.map((difference) => `listed, but both sides now agree; drop it: ${difference.side} ${difference.line}`),
    ]
    if (problems.length) failures.push(`✗ ${where} (${pair.harness} ${pair.native.version})\n${problems.map((problem) => `    ${problem}`).join("\n")}`)
  }
}

if (failures.length) {
  console.error(`\n${failures.join("\n\n")}\n`)
  console.error("- only the live wire draws it, + only the store does. Fix the side that is wrong, or list the difference in pair.json with why it stays.")
  process.exit(1)
}
console.log(`PASS: ${checked} capture/store pair${checked === 1 ? "" : "s"} draw the same`)
