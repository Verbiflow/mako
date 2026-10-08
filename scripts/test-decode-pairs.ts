import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { comparePair, PAIRS_FOLDER, type Compared, type Known } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"

/**
 * Every kept capture/store pair: the live wire through the live decoder and
 * each store through its reader must draw the same, apart from the
 * differences the pair lists with a reason. A capture that resumes also
 * checks the history the harness replayed against the live turns before it.
 * Pairs are recorded from real harness CLIs by
 * `npm run harness:decode-pairs -- <harness> --write`.
 */

const failures: string[] = []
let checked = 0
let stores = 0
let resumes = 0
let replays = 0
let cited = 0

function problems(result: Compared, known: Known): string[] {
  return [
    ...result.cited.conflicts,
    ...result.cited.oneSided,
    ...result.unexplained.map((difference) => `${difference.side} ${difference.line}`),
    ...known.filter((difference) => !difference.reason).map((difference) => `listed without a reason: ${difference.side} ${difference.line}`),
    ...result.settled.map((difference) => `listed, but both sides now agree; drop it: ${difference.side} ${difference.line}`),
  ]
}

for (const harness of await readdir(FIXTURE_ROOT)) {
  const root = join(FIXTURE_ROOT, harness, PAIRS_FOLDER)
  const names = await readdir(root).catch(() => [])
  for (const name of names) {
    const where = `${harness}/${PAIRS_FOLDER}/${name}`
    const { pair, stores: compared, resumes: resumed, replay } = await comparePair(join(root, name))
    checked++
    resumes += resumed
    const found: string[] = []
    for (const [index, store] of compared.entries()) {
      stores++
      cited += store.cited.agreed
      found.push(...problems(store, pair.stores[index]!.known).map((problem) => `${store.reader} ${problem}`))
    }
    if (replay) {
      replays++
      cited += replay.cited.agreed
      found.push(...problems(replay, pair.replay?.known ?? []).map((problem) => `replay ${problem}`))
    } else if (pair.replay) found.push(resumed ? "lists replay differences, but its resume replays nothing" : "lists replay differences, but its capture never resumes")
    if (found.length) failures.push(`✗ ${where} (${pair.harness} ${pair.native.version})\n${found.map((problem) => `    ${problem}`).join("\n")}`)
  }
}

if (failures.length) {
  console.error(`\n${failures.join("\n\n")}\n`)
  console.error("- only the live wire draws it (or, for a replay, only the live turns before it), + only the store or the replay does. Fix the side that is wrong, or list the difference in pair.json with why it stays.")
  process.exit(1)
}
console.log(`PASS: ${checked} captures draw the same as their ${stores} stores${resumes ? `, ${resumes} resumes drawing ${replays} replays the same as the live turns before them` : ""}, and ${cited} markers cite the same native record on both sides`)
