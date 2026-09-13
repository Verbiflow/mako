import { resolveFilePreview } from "../electron/file-previews.ts"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { DAEMON_NODE_ARGS } from "../electron/daemon-command.ts"
import { distributionFromMetadata } from "../electron/distribution.ts"
import { AgentHost } from "../electron/host.ts"
import { WorkspaceGit } from "../electron/host-git.ts"
import type { HostEvent } from "../electron/shared.ts"
import { searchWorkspace } from "../electron/host-search.ts"
import { WorkspaceFiles } from "../electron/host-workspace.ts"
import { workspacePreviewPath } from "../electron/workspace-preview.ts"
import { revealAction } from "../electron/reveal-policy.ts"

const execFileAsync = promisify(execFile)
assert.deepEqual(DAEMON_NODE_ARGS, ["--expose-gc", "--max-old-space-size=128"])
assert.equal(
  distributionFromMetadata('{"makoDistribution":"signed"}'),
  "signed"
)
assert.equal(distributionFromMetadata('{"makoDistribution":"local"}'), "local")
assert.equal(distributionFromMetadata('{"description":"makoDistribution signed"}'), "unsigned")
assert.equal(distributionFromMetadata('{"nested":{"makoDistribution":"signed"}}'), "unsigned")
assert.equal(distributionFromMetadata("not json"), "unsigned")
assert.equal(distributionFromMetadata("{}"), "unsigned")
assert.equal(existsSync(join(process.cwd(), "electron", "preload.js")), false)
const directory = await mkdtemp(join(tmpdir(), "mako-host-domains-"))
const firstRepo = join(directory, "first")
const secondRepo = join(directory, "second")
const remote = join(directory, "remote.git")

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd })
  return stdout.trim()
}

async function initializeRepo(path: string) {
  await mkdir(path)
  await git(path, "init", "-b", "main")
  await git(path, "config", "user.name", "Mako Test")
  await git(path, "config", "user.email", "mako@example.test")
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail("Timed out waiting for a workspace event")
}

assert.equal(
  workspacePreviewPath("mako-file://workspace/docs/My%20File.md"),
  "docs/My File.md"
)
assert.equal(
  workspacePreviewPath("mako-file://workspace/%2e%2e%2foutside.txt"),
  null
)
assert.equal(workspacePreviewPath("mako-file://other/docs/file.md"), null)
assert.equal(
  workspacePreviewPath("mako-file://workspace//Users/me/report/chart.png"),
  "/Users/me/report/chart.png"
)
assert.equal(workspacePreviewPath("mako-file://workspace///etc/hosts"), null)

// Reveal opens documents but only shows in Finder anything the default
// handler would run: bundles, executables, and launchable document types.
{
  const file = (mode: number, directory = false) => ({
    mode,
    isDirectory: () => directory,
  })
  assert.equal(revealAction("/tmp/report.md", file(0o644)), "open")
  assert.equal(revealAction("/tmp/chart.png", file(0o644)), "open")
  assert.equal(revealAction("/tmp/script.sh", file(0o644)), "open")
  assert.equal(revealAction("/tmp/script.sh", file(0o755)), "reveal")
  assert.equal(revealAction("/tmp/run.command", file(0o644)), "reveal")
  assert.equal(revealAction("/tmp/Setup.PKG", file(0o644)), "reveal")
  assert.equal(revealAction("/tmp/link.webloc", file(0o644)), "reveal")
  assert.equal(revealAction("/Applications/Foo.app", file(0o755, true)), "reveal")
  assert.equal(revealAction("/tmp/folder", file(0o755, true)), "reveal")
}

try {
  await initializeRepo(firstRepo)
  await mkdir(remote)
  await git(remote, "init", "--bare")
  await writeFile(join(firstRepo, "tracked.txt"), "alpha needle\n")
  await git(firstRepo, "add", "tracked.txt")
  await git(firstRepo, "commit", "-m", "Initial commit")
  await git(firstRepo, "remote", "add", "origin", remote)

  const workspaceGit = new WorkspaceGit(firstRepo)
  const workspaceFiles = new WorkspaceFiles(firstRepo, workspaceGit)

  await writeFile(
    join(firstRepo, "tracked.txt"),
    "alpha needle\nchanged line\n"
  )
  const diff = await workspaceGit.diff("tracked.txt")
  assert.equal(diff.oldFile?.contents, "alpha needle\n")
  assert.equal(diff.newFile?.contents, "alpha needle\nchanged line\n")
  const allDiffs = await workspaceGit.diffAll()
  assert.equal(allDiffs.diffs.length, 1)
  assert.equal(allDiffs.diffs[0]?.path, "tracked.txt")
  assert.equal(allDiffs.truncated, 0)

  await workspaceGit.stage(["tracked.txt"])
  assert.equal(
    (await workspaceGit.status()).files.find(
      (file) => file.path === "tracked.txt"
    )?.staged,
    true
  )
  await workspaceGit.unstage(["tracked.txt"])
  assert.equal(
    (await workspaceGit.status()).files.find(
      (file) => file.path === "tracked.txt"
    )?.staged,
    false
  )

  await git(firstRepo, "mv", "tracked.txt", "renamed.txt")
  await writeFile(join(firstRepo, "notes.txt"), "untracked needle\n")
  const status = await workspaceGit.status()
  const renamed = status.files.find((file) => file.status === "renamed")
  assert.ok(renamed)
  assert.equal(renamed.oldName, "tracked.txt")
  assert.equal(renamed.path, "renamed.txt")
  assert.equal(
    status.files.find((file) => file.path === "notes.txt")?.status,
    "untracked"
  )

  const listed = await workspaceFiles.list()
  assert.equal(
    listed.some((file) => file.path === "renamed.txt"),
    true
  )
  assert.equal(
    listed.some((file) => file.path === "notes.txt"),
    true
  )
  assert.equal(
    (await workspaceFiles.read("notes.txt")).contents,
    "untracked needle\n"
  )
  assert.equal(
    (await workspaceFiles.read(join(await realpath(firstRepo), "notes.txt")))
      .contents,
    "untracked needle\n"
  )
  await writeFile(
    join(firstRepo, "preview.png"),
    Buffer.from([137, 80, 78, 71])
  )
  const image = await workspaceFiles.read("preview.png")
  assert.equal(image.media, "image")
  assert.equal(image.mimeType, "image/png")
  assert.equal(
    resolveFilePreview(image.previewUrl!),
    join(await realpath(firstRepo), "preview.png")
  )
  assert.equal(resolveFilePreview(image.previewUrl! + "tampered"), null)
  // An agent writes reports and scripts outside the project and links them
  // from its answer; the viewer opens them by relative, absolute, or symlinked
  // path alike.
  await writeFile(join(directory, "outside.txt"), "outside\n")
  assert.equal(
    (await workspaceFiles.read("../outside.txt")).contents,
    "outside\n"
  )
  assert.equal(
    (await workspaceFiles.read(join(directory, "outside.txt"))).contents,
    "outside\n"
  )
  await symlink(join(directory, "outside.txt"), join(firstRepo, "outside-link"))
  assert.equal(
    (await workspaceFiles.read("outside-link")).contents,
    "outside\n"
  )
  assert.equal(
    await workspaceFiles.resolvePath("outside-link"),
    await realpath(join(directory, "outside.txt"))
  )

  const searched = await searchWorkspace(
    firstRepo,
    workspaceGit,
    async () => [],
    "needle",
    { threads: false }
  )
  assert.equal(
    searched.files.some((file) => file.path === "renamed.txt"),
    true
  )
  assert.equal(
    searched.files.some((file) => file.path === "notes.txt"),
    true
  )

  await workspaceGit.stageAll()
  assert.equal(
    (await workspaceGit.status()).files.every((file) => file.staged),
    true
  )
  await workspaceGit.commit("Rename tracked file")
  const log = await workspaceGit.log()
  assert.equal(log[0]?.subject, "Rename tracked file")
  assert.equal(
    (await workspaceGit.commitFiles(log[0]?.hash ?? "")).length > 0,
    true
  )

  const pushed = await workspaceGit.push()
  assert.equal(pushed.branch, "main")
  assert.equal(
    await git(directory, `--git-dir=${remote}`, "rev-parse", "refs/heads/main"),
    log[0]?.hash
  )

  await initializeRepo(secondRepo)
  await writeFile(join(secondRepo, "second.txt"), "second workspace\n")
  workspaceGit.setCwd(firstRepo)
  workspaceFiles.setCwd(firstRepo)
  const pendingRoot = workspaceGit.root()
  const pendingFiles = workspaceFiles.list()
  workspaceGit.setCwd(secondRepo)
  workspaceFiles.setCwd(secondRepo)
  const [, switchedFiles] = await Promise.all([pendingRoot, pendingFiles])
  assert.deepEqual(
    switchedFiles.map((file) => file.path),
    ["second.txt"]
  )
  const secondFiles = await workspaceFiles.list()
  assert.deepEqual(
    secondFiles.map((file) => file.path),
    ["second.txt"]
  )
  assert.equal((await workspaceGit.status()).root, await realpath(secondRepo))
  assert.equal(
    secondFiles.some((file) => file.path === "renamed.txt"),
    false
  )

  const hostEvents: HostEvent[] = []
  const host = new AgentHost("watch-test", (event) => hostEvents.push(event))
  try {
    await host.start(firstRepo)
    hostEvents.length = 0
    await writeFile(join(firstRepo, "watch-first.txt"), "first\n")
    await waitFor(() =>
      hostEvents.some(
        (event) =>
          event.type === "git" &&
          event.git.cwd === firstRepo &&
          event.git.files.some((file) => file.path === "watch-first.txt")
      )
    )

    await host.setCwd(secondRepo)
    hostEvents.length = 0
    await writeFile(join(firstRepo, "after-switch.txt"), "stale\n")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(
      hostEvents.some(
        (event) => event.type === "git" && event.git.cwd === firstRepo
      ),
      false
    )
    hostEvents.length = 0
    await writeFile(join(secondRepo, "watch-second.txt"), "second\n")
    await waitFor(() =>
      hostEvents.some(
        (event) =>
          event.type === "git" &&
          event.git.cwd === secondRepo &&
          event.git.files.some((file) => file.path === "watch-second.txt")
      )
    )
  } finally {
    await host.dispose()
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log("host git, workspace, search, and cache checks passed")
