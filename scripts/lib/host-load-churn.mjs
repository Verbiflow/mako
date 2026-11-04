import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/*
 * What many Fins do to a Mac while they work, for `bench:host-load`, in a process of its own so the bench's prober
 * keeps its own loop: each Fin edits files in its worktrees a few times a second and appends the call to its Claude
 * transcript; now and then it builds (hundreds of files under `dist/`, a formatter rewriting tracked files) and runs
 * tests that write and remove temporary files. Its argument is the plan as JSON; it runs until killed.
 */

const plan = JSON.parse(process.argv[2])
const pick = (list) => list[Math.floor(Math.random() * list.length)]
const between = (low, high) => low + Math.random() * (high - low)

function claudeLine(session, cwd, role, content, parent) {
  const uuid = randomUUID()
  const record = { type: role, uuid, parentUuid: parent, sessionId: session, timestamp: new Date().toISOString(), cwd, isSidechain: false, ...(role === "user" && { userType: "external" }), message: role === "assistant" ? { role, model: "claude-load", content } : { role, content } }
  return { line: `${JSON.stringify(record)}\n`, uuid }
}

/** The tracked files of a worktree, found once: `src/area-*\/part-*\/module-*.ts`. */
function trackedFiles(worktree) {
  const files = []
  for (const area of readdirSync(join(worktree, "src")))
    for (const part of readdirSync(join(worktree, "src", area)))
      for (const name of readdirSync(join(worktree, "src", area, part))) files.push(join(worktree, "src", area, part, name))
  return files
}

let writes = 0
for (const fin of plan.fins) {
  const files = fin.repositories.flatMap(trackedFiles)
  let parent = null
  const transcript = fin.transcript
  const say = (role, content) => {
    const { line, uuid } = claudeLine(fin.session, fin.path, role, content, parent)
    parent = uuid
    appendFileSync(transcript, line)
  }
  say("user", `You're ${fin.name}. Work on your part.`)
  const edit = () => {
    const file = pick(files)
    const id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`
    const content = `export const edited = ${Date.now()}\n${"// a line the agent wrote\n".repeat(4)}`
    say("assistant", [{ type: "text", text: "Editing the next file. ".repeat(8) }, { type: "tool_use", id, name: "Write", input: { file_path: file, content } }])
    writeFileSync(file, content)
    writes += 1
    say("user", [{ type: "tool_result", tool_use_id: id, content: `The file ${file} has been updated.` }])
    setTimeout(edit, between(plan.editMs[0], plan.editMs[1]))
  }
  const build = () => {
    const dist = join(pick(fin.repositories), "dist", `chunk-${Date.now()}`)
    mkdirSync(dist, { recursive: true })
    for (let n = 0; n < plan.buildFiles; n += 1) writeFileSync(join(dist, `file-${n}.js`), `export default ${n}\n`)
    for (let n = 0; n < plan.formatFiles; n += 1) {
      const file = pick(files)
      writeFileSync(file, `export const formatted = ${n}\n${"// formatted\n".repeat(5)}`)
    }
    const scratch = join(plan.temporary, `vitest-${randomUUID()}`)
    mkdirSync(scratch, { recursive: true })
    for (let n = 0; n < plan.temporaryFiles; n += 1) writeFileSync(join(scratch, `snapshot-${n}.json`), "{}\n")
    setTimeout(() => rmSync(scratch, { recursive: true, force: true }), 5_000)
    setTimeout(() => rmSync(dist, { recursive: true, force: true }), 20_000)
    setTimeout(build, between(plan.buildMs[0], plan.buildMs[1]))
  }
  setTimeout(edit, between(0, plan.editMs[1]))
  setTimeout(build, between(plan.buildMs[0] / 2, plan.buildMs[1]))
}
setInterval(() => process.send?.({ writes }), 1_000).unref()
