// "Open pull requests as me" on a cloud machine: who a pull request goes as is settled before anything is pushed,
// said in the line that reports it, and a token that can't be used refuses with the problem and pushes nothing, never
// going as the App instead unless the person chose that for this one. Real Git against a local origin; a `gh` that
// answers as GitHub would and records what it was asked. The machine's Git helper and `gh` pick the token by what
// the agent keeps (tested beside them); here the host's side: the ask, the refusals and the App's switch.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, beforeEach, test } from "node:test"
import { promisify } from "node:util"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "machine-pr-author-"))
after(() => rm(root, { recursive: true, force: true }))

// What the stand-in `gh` and the origin's hook record, and how `gh pr create` answers this time.
const calls = join(root, "calls.log")
const answer = join(root, "create-answer")
const opened = join(root, "opened")
const gh = join(root, "gh")
await writeFile(gh, `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "gh version 2.103.3" ;;
  "repo view") echo '{"nameWithOwner":"acme/shop","defaultBranchRef":{"name":"main"}}' ;;
  "pr view") [ -f "${opened}" ] && echo '{"number":12,"title":"Add the cart","state":"OPEN","isDraft":false,"url":"https://github.com/acme/shop/pull/12","headRefName":"cart","baseRefName":"main","statusCheckRollup":[],"latestReviews":[]}' || exit 1 ;;
  "pr create"|"pr merge"|"pr edit")
    echo "$1 $2 as=\${MAKO_GITHUB_AS:-default}" >> "${calls}"
    case "$(cat "${answer}" 2>/dev/null)" in
      401) echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1 ;;
      403) echo "GraphQL: Resource not accessible by personal access token (createPullRequest)" >&2; exit 1 ;;
    esac
    touch "${opened}"
    echo "https://github.com/acme/shop/pull/12" ;;
  *) exit 1 ;;
esac
`)
await chmod(gh, 0o755)
process.env.GH_PATH = gh
// Who the Thread's person is, as the machine's App access says it (`MAKO_GITHUB_ACCESS`).
const access = join(root, "github")
await mkdir(access)
await writeFile(join(access, "access.json"), JSON.stringify({ repository: "acme/shop", expiresAt: "2099-01-01T00:00:00.000Z", permissions: {}, user: { id: "1001", login: "ada", name: "Ada", email: "1001+ada@users.noreply.github.com" } }))
process.env.MAKO_GITHUB_ACCESS = access

const { hostGit } = await import("@mako/host/git")
const { openPullRequest, mergePullRequest, openedSentence, PersonTokenError } = await import("@mako/host/git/pull-requests")
const { readPersonTokenProblem, personTokenWords, MAKO_GITHUB_APP } = await import("@mako/host/contracts/github-person")
const { followHostLog } = await import("@mako/host/base/host-log")
type GitHubPerson = import("@mako/host/contracts/github-person").GitHubPerson

const git = hostGit(false)
after(() => git.close())
const origin = join(root, "origin.git")
const work = join(root, "work")
const hook = join(origin, "hooks", "pre-receive")
const refuse = join(root, "refuse-push")

async function g(cwd: string, ...args: string[]) {
  return (await run("git", args, { cwd })).stdout.trim()
}

/** A fresh origin with `main`, a checkout on `cart` one commit ahead, and an origin hook that records each push's identity. */
beforeEach(async () => {
  await rm(origin, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
  for (const file of [calls, answer, opened, refuse]) await rm(file, { force: true })
  await run("git", ["init", "-q", "--bare", "-b", "main", origin])
  await writeFile(hook, `#!/bin/sh
echo "push as=\${MAKO_GITHUB_AS:-default}" >> "${calls}"
if [ -f "${refuse}" ]; then echo "Authentication failed for 'https://github.com/acme/shop.git/'" >&2; exit 1; fi
`)
  await chmod(hook, 0o755)
  await run("git", ["clone", "-q", origin, work])
  await g(work, "config", "user.email", "ada@example.invalid")
  await g(work, "config", "user.name", "Ada")
  await writeFile(join(work, "README.md"), "shop\n")
  await g(work, "add", ".")
  await g(work, "commit", "-qm", "Start")
  await g(work, "push", "-q", "origin", "HEAD:main")
  await g(work, "fetch", "-q", "origin")
  await g(work, "checkout", "-qb", "cart")
  await writeFile(join(work, "cart.ts"), "export const cart = []\n")
  await g(work, "add", ".")
  await g(work, "commit", "-qm", "Add the cart")
  await writeFile(calls, "")
})

const recorded = async () => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean)
const pushedBranch = async () => (await run("git", ["--git-dir", origin, "branch", "--list", "cart"])).stdout.trim()
const asking = (person: GitHubPerson | undefined) => {
  const asked: number[] = []
  return { asked, personOf: async () => (asked.push(Date.now()), person) }
}
const draft = { title: "Add the cart", body: "Adds the cart." }

test("on a Mac nothing changes: no ask, no author in the line", async () => {
  const opened = await openPullRequest(git, work, draft)
  assert.equal(opened.author, undefined)
  assert.equal(openedSentence(opened), "Opened #12 into main: https://github.com/acme/shop/pull/12")
  assert.deepEqual(await recorded(), ["push as=default", "pr create as=default"])
})

test("off: it goes as Mako's App, and says so", async () => {
  const { asked, personOf } = asking({ state: "off" })
  const opened = await openPullRequest(git, work, draft, null, personOf)
  assert.equal(asked.length, 1, "asked once, before anything was pushed")
  assert.deepEqual(opened.author, { as: "app", chosen: false })
  assert.equal(openedSentence(opened), `Opened #12 into main as ${MAKO_GITHUB_APP}: https://github.com/acme/shop/pull/12`)
})

test("on: the push and the pull request go as the person (the machine's helper and gh carry their token), and the line names them", async () => {
  const { personOf } = asking({ state: "on", login: "ada", expiresAt: "2099-01-01T00:00:00.000Z" })
  const opened = await openPullRequest(git, work, draft, null, personOf)
  assert.deepEqual(opened.author, { as: "person", login: "ada" })
  assert.match(openedSentence(opened), /^Opened #12 into main as @ada: /)
  assert.deepEqual(await recorded(), ["push as=default", "pr create as=default"], "never told to go as the App")
  const merged = await mergePullRequest(work, "squash", personOf)
  assert.deepEqual(merged.author, { as: "person", login: "ada" })
})

test("a token that lapsed, can't be opened, or whose state isn't known refuses before anything is pushed", async () => {
  const cases: Array<[GitHubPerson, string, RegExp]> = [
    [{ state: "on", login: "ada", expiresAt: "2026-10-01T00:00:00.000Z" }, "expired", /@ada's GitHub token expired/],
    [{ state: "unusable", problem: "Mako Cloud couldn't open your GitHub token." }, "unusable", /couldn't be used here/],
    [{ state: "unknown", problem: "This machine's agent didn't say in time whether to open pull requests as you." }, "unknown", /couldn't be used here/],
  ]
  for (const [person, reason, title] of cases) {
    const refused = await openPullRequest(git, work, draft, null, asking(person).personOf).then(() => undefined, (error: Error) => error)
    assert.ok(refused instanceof PersonTokenError, reason)
    const problem = readPersonTokenProblem(refused.message)
    assert.equal(problem?.reason, reason, "the refusal carries its problem for the transcript")
    assert.equal(problem?.repository, "acme/shop")
    assert.match(personTokenWords(problem!).title, title)
    assert.match(refused.message, /Call pull_request_open again with as: "app" only if they choose that/)
    assert.equal(await pushedBranch(), "", "nothing pushed")
    assert.deepEqual(await recorded(), [], "neither Git nor gh was asked to write")
  }
})

test("GitHub refusing the person's push or pull request is said as their token's problem, never retried as the App", async () => {
  const on: GitHubPerson = { state: "on", login: "ada", expiresAt: null }
  await writeFile(refuse, "")
  const pushRefused = await openPullRequest(git, work, draft, null, asking(on).personOf).then(() => undefined, (error: Error) => error)
  assert.ok(pushRefused instanceof PersonTokenError)
  assert.deepEqual(pushRefused.problem, { reason: "refused", login: "ada", repository: "acme/shop" })
  assert.deepEqual(await recorded(), ["push as=default"], "one push, no pull request, no second try as the App")

  await rm(refuse)
  await writeFile(calls, "")
  await writeFile(answer, "403")
  const short = await openPullRequest(git, work, draft, null, asking(on).personOf).then(() => undefined, (error: Error) => error)
  assert.ok(short instanceof PersonTokenError)
  assert.equal(short.problem.reason, "no-access")
  assert.match(personTokenWords(short.problem).title, /can't push to acme\/shop/)

  await writeFile(calls, "")
  await writeFile(answer, "401")
  const revoked = await openPullRequest(git, work, draft, null, asking(on).personOf).then(() => undefined, (error: Error) => error)
  assert.ok(revoked instanceof PersonTokenError)
  assert.equal(revoked.problem.reason, "refused")
  assert.deepEqual(await recorded(), ["pr create as=default"], "the branch went up the time before: nothing new to push, and no second try as the App")
})

test("the person's choice opens it as the App this once: Git and gh are told, and the line says it", async () => {
  const { personOf } = asking({ state: "on", login: "ada", expiresAt: "2026-10-01T00:00:00.000Z" })
  const opened = await openPullRequest(git, work, { ...draft, as: "app" }, null, personOf)
  assert.deepEqual(opened.author, { as: "app", chosen: true })
  assert.match(openedSentence(opened), new RegExp(`as ${MAKO_GITHUB_APP}: `))
  assert.deepEqual(await recorded(), ["push as=app", "pr create as=app"])
})

test("the refusal's tag is read back whole, and text without one is nothing", async () => {
  const lines: string[] = []
  const stop = followHostLog((line) => void lines.push(JSON.stringify(line)))
  const { personTokenRefusal } = await import("@mako/host/contracts/github-person")
  const text = personTokenRefusal({ reason: "expired", login: "ada", repository: "acme/shop", expiredAt: "2026-10-01T00:00:00.000Z" })
  assert.deepEqual(readPersonTokenProblem(text), { reason: "expired", login: "ada", repository: "acme/shop", expiredAt: "2026-10-01T00:00:00.000Z" })
  assert.equal(readPersonTokenProblem("Opened #12 into main: https://github.com/acme/shop/pull/12"), undefined)
  assert.equal(readPersonTokenProblem(undefined), undefined)
  const sneaky = personTokenRefusal({ reason: "unusable", said: 'says "quoted" <b>things</b>' })
  assert.equal(readPersonTokenProblem(sneaky)?.said, "says quoted bthings/b", "what's said can't break out of its attribute")
  stop()
  assert.ok(!lines.join("\n").includes("github_pat_"), "the host never holds a token to log")
})
