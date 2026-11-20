import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { cloneNeedsSignIn, clonePercent, cloneStep, githubRepository, remoteLabel, type CloneProgress } from "@mako/host/contracts/projects"
import { browseTarget, expandPath, ProjectFolders } from "@mako/host/workspaces/project-folders"
import { asksForProject, cloneParent, completePath, projectNameProblem, projectQuery, tildePath } from "../src/lib/project-query"

/**
 * Open project's pieces below the palette: what a typed query is, how paths complete and where clones go, the
 * host's browse, scan of home, new projects and clones (a real `git clone` of a local repository standing in for
 * GitHub through `url.insteadOf`), and the host-call contract for each method.
 */

// What's typed.
assert.deepEqual(projectQuery(""), { kind: "empty" })
assert.deepEqual(projectQuery("~/code"), { kind: "path", text: "~/code" })
assert.deepEqual(projectQuery("/tmp"), { kind: "path", text: "/tmp" })
assert.deepEqual(projectQuery("../sibling"), { kind: "path", text: "../sibling" })
assert.deepEqual(projectQuery("~"), { kind: "path", text: "~" })
assert.equal(projectQuery("acme/lantern").kind, "repository")
assert.equal(projectQuery("https://github.com/acme/lantern/tree/main/src").kind, "repository")
assert.equal(projectQuery("git@github.com:acme/lantern.git").kind, "repository")
assert.deepEqual(projectQuery("lantern docs"), { kind: "search", term: "lantern docs" })
assert.deepEqual(projectQuery("lantern"), { kind: "search", term: "lantern" })
assert.ok(asksForProject("~/code") && asksForProject("https://github.com/a/b") && !asksForProject("new thread"), "⌘K hands paths and addresses to Open project, nothing else")
console.log("PASS: a query is a path, a repository or a search")

// GitHub addresses.
assert.deepEqual(githubRepository("acme/lantern"), { owner: "acme", name: "lantern", url: "https://github.com/acme/lantern" })
assert.deepEqual(githubRepository("https://github.com/acme/lantern.git"), { owner: "acme", name: "lantern", url: "https://github.com/acme/lantern" })
assert.deepEqual(githubRepository("github.com/acme/my.repo"), { owner: "acme", name: "my.repo", url: "https://github.com/acme/my.repo" })
assert.equal(githubRepository("https://gitlab.com/acme/lantern"), undefined, "another host isn't GitHub")
assert.equal(githubRepository("acme/.."), undefined, "no path traversal in a name")
assert.equal(githubRepository("-acme/x"), undefined)
assert.equal(remoteLabel("git@github.com:acme/lantern.git"), "acme/lantern")
assert.equal(remoteLabel("https://example.com/r.git"), "https://example.com/r.git")
console.log("PASS: GitHub addresses in every shape Git takes, and nothing else")

// Git's progress, and its refusals.
assert.deepEqual(cloneStep("Receiving objects:  45% (450/1000), 1.2 MiB | 3 MiB/s"), { phase: "Receiving objects", percent: 45 })
assert.deepEqual(cloneStep("remote: Counting objects: 100% (10/10), done."), { phase: "Counting objects", percent: 100 })
assert.deepEqual(cloneStep("Cloning into 'lantern'..."), { phase: "Connecting" })
assert.equal(cloneStep("warning: something"), undefined)
assert.equal(clonePercent({ phase: "Receiving objects", percent: 50 }), 45)
assert.equal(clonePercent({ phase: "Resolving deltas", percent: 100 }), 95)
assert.equal(clonePercent({ phase: "Connecting" }), undefined)
assert.ok(cloneNeedsSignIn("fatal: could not read Username for 'https://github.com': terminal prompts disabled"))
assert.ok(cloneNeedsSignIn("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found"))
assert.ok(!cloneNeedsSignIn("fatal: unable to access: Could not resolve host: github.com"))
console.log("PASS: clone progress reads Git's lines; sign-in failures are told apart")

// Paths.
assert.equal(completePath("~/co", "code"), "~/code/")
assert.equal(completePath("~/code/", "lantern"), "~/code/lantern/")
assert.equal(completePath("~", "code"), "~/code/")
assert.equal(tildePath("/Users/someone/code", "/Users/someone"), "~/code")
assert.equal(tildePath("/opt/x", "/Users/someone"), "/opt/x")
assert.equal(cloneParent(["/Users/someone/code/a", "/Users/someone/code/b", "/Users/someone/work/c"], "/Users/someone"), "/Users/someone/code", "where most recent projects sit")
assert.equal(cloneParent(["/Users/someone/a", "/Users/someone/b"], "/Users/someone"), "/Users/someone", "projects right in home clone into home")
assert.equal(cloneParent([], "/Users/someone"), "/Users/someone")
assert.equal(projectNameProblem("good-name"), undefined)
assert.ok(projectNameProblem("a/b") && projectNameProblem(".hidden"))
assert.equal(expandPath("~/code", "/h"), "/h/code")
assert.equal(expandPath("../x", "/h", "/h/code/app"), "/h/code/x")
assert.deepEqual(browseTarget("~/co", "/h"), { folder: "/h", prefix: "co", path: "/h/co" })
assert.deepEqual(browseTarget("~/code/", "/h"), { folder: "/h/code", prefix: "", path: "/h/code" })
console.log("PASS: completion, ~ display, where clones go, names")

// The host's side, in a scratch home.
const home = await realpath(await mkdtemp(join(tmpdir(), "mako-open-project-")))
const events: HostEvent[] = []
const folders = new ProjectFolders({ emit: (event) => events.push(event), home })
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString()
try {
  const checkout = async (path: string, origin?: string) => {
    await mkdir(path, { recursive: true })
    git(path, "init", "--quiet")
    if (origin) git(path, "remote", "add", "origin", origin)
  }
  await checkout(join(home, "code", "lantern"), "git@github.com:acme/lantern.git")
  await checkout(join(home, "code", "org", "deep", "tool"), "https://github.com/acme/tool")
  await checkout(join(home, "code", "a", "b", "c", "too-deep"))
  await checkout(join(home, "code", "node_modules", "dep"))
  await checkout(join(home, "Documents", "guarded"))
  await mkdir(join(home, "code", "notes"), { recursive: true })
  await mkdir(join(home, "code", ".hidden"), { recursive: true })
  await mkdir(join(home, "code", "lantern", "src"), { recursive: true })
  await writeFile(join(home, "code", "linked-worktree-file"), "x")
  await mkdir(join(home, "code", "worktree"), { recursive: true })
  await writeFile(join(home, "code", "worktree", ".git"), "gitdir: /elsewhere\n")

  const listed = await folders.browse({ partialPath: "~/code/" })
  assert.equal(listed.home, home)
  assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.git]), [["a", false], ["lantern", true], ["node_modules", false], ["notes", false], ["org", false], ["worktree", false]], "folders only, no dotfolders, git roots marked")
  assert.deepEqual(listed.exact, { path: join(home, "code"), kind: "folder", git: false })
  const narrowed = await folders.browse({ partialPath: "~/code/LA" })
  assert.deepEqual(narrowed.entries.map((entry) => entry.name), ["lantern"], "the last part narrows, any case")
  assert.equal(narrowed.exact.kind, "missing")
  const exact = await folders.browse({ partialPath: "~/code/lantern" })
  assert.deepEqual(exact.exact, { path: join(home, "code", "lantern"), kind: "folder", git: true, repository: "acme/lantern" })
  assert.deepEqual((await folders.browse({ partialPath: "~/code/." })).entries.map((entry) => entry.name), [".hidden"], "a dot typed shows dotfolders")
  assert.deepEqual((await folders.browse({ partialPath: "./src", base: join(home, "code", "lantern") })).exact.kind, "folder", "./ starts from the project on screen")
  assert.equal((await folders.browse({ partialPath: "~/nowhere/x" })).listed, false)
  await assert.rejects(folders.browse({ partialPath: "a\0b" }), /expected a path/)
  console.log("PASS: browse lists folders, marks checkouts, resolves ~ ./ and ..")

  const scanned = await folders.scan()
  const found = scanned.checkouts.map((each) => each.path.slice(home.length + 1)).sort()
  assert.deepEqual(found, ["code/lantern", "code/org/deep/tool"], `depth four, no dependencies, no worktrees, no guarded folders: ${JSON.stringify(found)}`)
  assert.equal(scanned.checkouts.find((each) => each.name === "lantern")?.remote, "acme/lantern")
  assert.ok(scanned.checkouts.every((each) => each.branch), "each says its branch")
  const within = await folders.scan([join(home, "Documents")])
  assert.ok(within.checkouts.some((each) => each.name === "guarded"), "a guarded folder asked for is scanned")
  const first = folders.found({ within: [] })
  assert.equal(first.state, "scanning", "the first ask never waits for the scan")
  for (let at = 0; at < 100 && !events.some((event) => event.type === "folders-found"); at++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(events.some((event) => event.type === "folders-found"), "the scan's end is an event")
  assert.equal(folders.found({ within: [] }).state, "ready", "and later asks answer from it")
  console.log("PASS: the scan of home is bounded, cached and never blocks")

  const made = await folders.create({ path: "~/code/new-thing", git: true })
  assert.equal(made.path, join(home, "code", "new-thing"))
  assert.ok((await stat(join(made.path, ".git"))).isDirectory(), "git init ran")
  await assert.rejects(folders.create({ path: "~/code/new-thing", git: false }), /already exists/)
  await assert.rejects(folders.create({ path: "~/code/../escape", git: false }), /without \. or \.\./)
  await assert.rejects(folders.create({ path: "~/a/b/c/d/e", git: false }), /at most 3 new folders/)
  await assert.rejects(folders.create({ path: "relative/x", git: false }), /whole path/)
  const plain = await folders.create({ path: join(home, "plain"), git: false })
  assert.deepEqual(await readdir(plain.path), [], "a plain folder is just a folder")
  console.log("PASS: new projects stay below a folder that exists, never over one")

  // Clones: a local repository stands in for GitHub.
  const remotes = join(home, "remotes")
  await checkout(join(remotes, "acme", "reef.git"))
  git(join(remotes, "acme", "reef.git"), "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "first", "--quiet")
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = `url.file://${remotes}/.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/"
  const ended = (id: string) => new Promise<CloneProgress>((resolve) => {
    const look = setInterval(() => {
      const last = events.filter((event): event is Extract<HostEvent, { type: "project-clone" }> => event.type === "project-clone" && event.clone.id === id).at(-1)
      if (last && last.clone.state.kind !== "cloning") {
        clearInterval(look)
        resolve(last.clone)
      }
    }, 20)
  })
  const accepted = await folders.clone({ id: "clone-1", repository: "https://github.com/acme/reef", into: "~/code" })
  assert.deepEqual(accepted, { path: join(home, "code", "reef"), already: false })
  assert.deepEqual(await folders.clone({ id: "clone-1", repository: "https://github.com/acme/reef", into: "~/code" }), accepted, "a repeated id answers as the first")
  await assert.rejects(folders.clone({ id: "clone-1", repository: "acme/other", into: "~/code" }), /other details/)
  const done = await ended("clone-1")
  assert.deepEqual(done.state, { kind: "done", path: join(home, "code", "reef") })
  assert.ok(events.some((event) => event.type === "project-clone" && event.clone.state.kind === "cloning"), "progress came first")
  git(join(home, "code", "reef"), "remote", "set-url", "origin", "https://github.com/acme/reef")
  assert.deepEqual(await folders.clone({ id: "clone-2", repository: "acme/reef", into: join(home, "code") }), { path: join(home, "code", "reef"), already: true }, "already cloned there")
  await assert.rejects(folders.clone({ id: "clone-3", repository: "someone-else/lantern", into: "~/code" }), /already exists/, "another folder by that name is never cloned over")
  await assert.rejects(folders.clone({ id: "clone-4", repository: "not a repo", into: "~/code" }), /isn't a GitHub repository/)
  await assert.rejects(folders.clone({ id: "clone-5", repository: "acme/reef", into: "~/missing" }), /isn't a folder/)
  await assert.rejects(folders.clone({ id: "../x", repository: "acme/reef", into: "~/code" }), /expected an id/)
  const missing = await folders.clone({ id: "clone-6", repository: "acme/absent", into: "~/code" })
  const failed = await ended("clone-6")
  assert.equal(failed.state.kind, "failed")
  await assert.rejects(stat(missing.path), /ENOENT/, "a failed clone leaves nothing behind")
  await folders.clone({ id: "clone-7", repository: "acme/reef", into: "~/plain" })
  await folders.cancelClone("clone-7")
  const cancelled = await ended("clone-7")
  assert.ok(cancelled.state.kind === "cancelled" || cancelled.state.kind === "done", `a cancel ends the clone: ${cancelled.state.kind}`)
  if (cancelled.state.kind === "cancelled") await assert.rejects(stat(join(home, "plain", "reef")), /ENOENT/, "and removes what it wrote")
  console.log("PASS: clones report progress, refuse what they'd overwrite, clean up after failing or cancelling")
} finally {
  delete process.env.GIT_CONFIG_COUNT
  await rm(home, { recursive: true, force: true })
}

// The host-call contract.
assert.equal(hostCallReplay("mako:folders-browse"), "read")
assert.equal(hostCallReplay("mako:folders-found"), "read")
assert.equal(hostCallReplay("mako:project-clone"), "replay")
assert.equal(hostCallReplay("mako:project-clone-cancel"), "replay")
assert.equal(hostCallReplay("mako:project-create"), "never", "making a folder twice is the person's call")
assert.ok(hostCallSchema("mako:folders-browse").safeParse([{ partialPath: "~/", base: "/x" }]).success)
assert.ok(!hostCallSchema("mako:folders-browse").safeParse([{}]).success)
assert.ok(hostCallSchema("mako:project-clone").safeParse([{ id: "a", repository: "acme/reef", into: "~/code" }]).success)
assert.ok(hostCallSchema("mako:pick-folder").safeParse([]).success && hostCallSchema("mako:pick-folder").safeParse(["/Users/someone"]).success, "the chooser takes a folder to open at, or none")
console.log("PASS: each method's schema and replay policy")
