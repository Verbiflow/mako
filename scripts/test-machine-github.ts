// GitHub on a cloud machine: its access is a GitHub App's token for the Thread's repository, which can't ask GitHub
// who it is, so the host reads who the Thread's person is from beside it (`MAKO_GITHUB_ACCESS`), and the Git panel,
// pull requests and their tools work there as they do on the Mac. Anywhere else, `gh`'s own sign-in says.
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

const root = await mkdtemp(join(tmpdir(), "machine-github-"))
after(() => rm(root, { recursive: true, force: true }))

// A `gh` that answers as an App's token does: its version and the repository, never `api user`.
const gh = join(root, "gh")
await writeFile(gh, `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "gh version 2.103.3" ;;
  "api user") echo '{"message":"Resource not accessible by integration"}' >&2; exit 1 ;;
  "repo view") echo '{"nameWithOwner":"acme/shop","defaultBranchRef":{"name":"main"}}' ;;
  *) exit 1 ;;
esac
`)
await chmod(gh, 0o755)
process.env.GH_PATH = gh
const access = join(root, "github")
await mkdir(access)
process.env.MAKO_GITHUB_ACCESS = access
const { githubStatus } = await import("@mako/host/git/github")

test("on a machine with GitHub access, GitHub is signed in as the Thread's person, for its repository", async () => {
  await writeFile(join(access, "access.json"), JSON.stringify({ repository: "acme/shop", expiresAt: "2026-10-28T11:00:00.000Z", permissions: { contents: "write" }, user: { id: "1001", login: "ada", name: "Ada", email: "1001+ada@users.noreply.github.com" } }))
  assert.deepEqual(await githubStatus(root), { installed: true, authenticated: true, login: "ada", userId: "1001", repo: "acme/shop", defaultBranch: "main" })
})

test("with none (a public repository, or none given yet), it's what gh says: here, not signed in", async () => {
  await rm(join(access, "access.json"), { force: true })
  assert.deepEqual(await githubStatus(root), { installed: true, authenticated: false })
})
