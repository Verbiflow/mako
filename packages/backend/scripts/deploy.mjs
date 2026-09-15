import { existsSync, renameSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(backendRoot, "../..")
const allowedAuthor = process.env.VERCEL_DEPLOY_AUTHOR_EMAIL
if (!allowedAuthor) {
  console.error(
    "Set VERCEL_DEPLOY_AUTHOR_EMAIL to the Git author email Vercel accepts"
  )
  process.exit(1)
}

function command(program, args) {
  const result = spawnSync(program, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    stdio: ["inherit", "pipe", "inherit"],
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}

function preservePrebuiltOutput(path) {
  if (!existsSync(path)) return
  const preserved = `${path}-stale-${Date.now()}`
  renameSync(path, preserved)
  console.info(`Preserved stale prebuilt output at ${preserved}`)
}

const dirty = command("git", ["status", "--porcelain"])
if (dirty) {
  console.error("Refusing to deploy an uncommitted backend worktree")
  process.exit(1)
}

const author = command("git", ["log", "-1", "--format=%ae"])
if (author !== allowedAuthor) {
  console.error(
    `Refusing to deploy Git author ${author}; Vercel requires ${allowedAuthor}`
  )
  process.exit(1)
}

preservePrebuiltOutput(join(repositoryRoot, ".vercel", "output"))
preservePrebuiltOutput(join(backendRoot, ".vercel", "output"))

const deploymentArgs = [
  "--yes",
  "vercel@59.1.3",
  "deploy",
  "--prod",
  "--yes",
  "--archive=tgz",
  ...(process.env.VERCEL_FORCE_DEPLOY === "1" ? ["--force"] : []),
  "--cwd",
  repositoryRoot,
]

const deployment = spawnSync(
  "npx",
  deploymentArgs,
  {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  }
)
process.exit(deployment.status ?? 1)
