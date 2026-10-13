import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { format } from "prettier"

const repository = resolve(import.meta.dirname, "..")
const output = join(repository, "packages/host/src/harnesses/codex/generated")
const temporary = await mkdtemp(join(tmpdir(), "mako-codex-inputs-"))
const executable = process.env.MAKO_CODEX_EXECUTABLE ?? "codex"
try {
  execFileSync(
    executable,
    ["app-server", "generate-ts", "--experimental", "--out", temporary],
    { stdio: "pipe", timeout: 30_000 }
  )
  const files = new Map()
  async function collect(path) {
    if (files.has(path)) return
    if (files.size >= 150)
      throw new Error("Codex input type dependency limit exceeded")
    const source = await readFile(join(temporary, path), "utf8")
    files.set(path, source)
    for (const match of source.matchAll(/from "([^"]+)"/g)) {
      const dependency = relative(
        temporary,
        resolve(temporary, dirname(path), `${match[1]}.ts`)
      )
      if (dependency.startsWith(".."))
        throw new Error("Codex type import leaves the generated directory")
      await collect(dependency)
    }
  }
  for (const name of [
    "ThreadItem",
    "TurnStartParams",
    "TurnSteerParams",
    "ThreadCompactStartParams",
    "TurnInterruptParams",
    "ThreadGoalSetParams",
    "ThreadGoalClearParams",
    "ThreadGoal",
    "ThreadForkParams",
    "ThreadInjectItemsParams",
    "ThreadUnsubscribeParams",
    "ThreadUnsubscribeResponse",
    "ConfigReadParams",
    "ReviewStartParams",
  ])
    await collect(`v2/${name}.ts`)
  for (const [path, source] of files) {
    const target = join(output, path)
    await mkdir(dirname(target), { recursive: true })
    const content = source.replace(/from "(\.[^"]+)"/g, 'from "$1.js"')
    await writeFile(
      target,
      await format(content, {
        parser: "typescript",
        semi: false,
        printWidth: 80,
      })
    )
  }
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
  }).trim()
  await writeFile(
    join(output, "README.md"),
    `Generated from ${version} using the official app-server generator.\n\nRun \`npm run generate:codex-inputs\` after upgrading the runtime. The script retains only the protocol types Mako uses and their dependencies and adds NodeNext import extensions. These files remain subject to normal lint and type checks.\n`
  )
  console.log(`Generated ${files.size} Codex input type files from ${version}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
