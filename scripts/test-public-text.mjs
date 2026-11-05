import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { addedLines, changeLeaks, denylistPatterns, findLeaks } from "./check-public-text.mjs"

const kinds = (text) => findLeaks(text).map(({ kind }) => kind)

// A person's home folder, however a tool spells it; placeholders and paths that merely hold "home" pass.
for (const text of [
  "cd /Users/jordan/projects/app",
  "/home/jordan/.npm/_npx/x",
  "file:///Users/jordan/a.ts",
  'import("C:/Users/Jordan-PC/.codex/x")',
  "C:\\\\Users\\\\jordan\\\\AppData",
  "~/.claude/projects/-Users-jordan-work-app/1.jsonl",
  "sessions/%2FUsers%2Fjordan%2Fwork",
  "opencode?directory=%2Fhome%2Fjordan",
  "`/Users/jordan`.",
  "/home/jordan.jsonl/work/app",
  "/Users/jordan.md/",
  "C:\\\\Users\\\\jordan.log\\\\AppData",
  "sessions/%2FUsers%2Fjordan.txt%2Fwork",
])
  assert.deepEqual(kinds(text), ["home path"], text)
for (const text of [
  "/Users/someone/work/app",
  "/Users/me/x and /Users/you/y and /home/node/app and /home/runner/work",
  "/Users/ada-canary/x /Users/tester0/x /Users/dev-other/x /Users/a/b/c.ts",
  "/Users/<name>/x and /Users/${user}/x",
  "src/components/home/HomeScreen.tsx and root/home/Library and /home/pace.jsonl",
  "contents/mobile%2Fsrc%2Ffeatures%2Fhome%2FHomeScreen.tsx and \\\\ctor\\\\codex\\\\home\\\\sessions",
  "~/.claude/projects/-Users-someone-flage/1.jsonl",
  "the --home-dir flag and work-from-home-office",
  "Saved under /Users/me.",
])
  assert.deepEqual(kinds(text), [], text)

// macOS's per-user temporary folder, in each spelling.
for (const text of ["/var/folders/ab/xyz/T/run", "/private/var/folders/ab/xyz/T", "-private-var-folders-ab-xyz-T", "%2Fvar%2Ffolders%2Fab"])
  assert.deepEqual(kinds(text), ["temporary folder"], text)
assert.deepEqual(kinds("/private/tmp/mako-run and $TMPDIR/mako-run"), [])

// A personal address; documentation domains, no-reply senders, agents' trailers, remotes and file names pass.
for (const text of ["mail jordan@gmail.com.", "Signed-off-by: Jo <jo.smith+x@company.io>", "git@jordan-family.com", "mail git@jordan-family.com: soon", "git@jordan-family.com:42", "git@jordan-family.com/repo"]) assert.deepEqual(kinds(text), ["email"], text)
for (const text of [
  "a@example.com b@mail.example.org c@example.net f@example.invalid t@host.test x@mako.local",
  "Co-authored-by: Claude <noreply@anthropic.com>",
  "Co-authored-by: Cursor <cursoragent@cursor.com>",
  "123+bot[bot]@users.noreply.github.com",
  "git@github.com:Verbiflow/mako.git",
  "ssh://git@github.com/Verbiflow/mako.git and git+ssh://git@gitlab.com:22/team/app and git@bitbucket.org:team/app",
  "effect@4.0.0-beta.78.patch native-1@launch-1.jsonl icon@2x.png @scope/pkg",
])
  assert.deepEqual(kinds(text), [], text)

// Every name the denylist holds trips, as a word in any case; R2 only as itself, never a variable.
const denylist = await readFile(fileURLToPath(new URL("public-text-denylist.txt", import.meta.url)), "utf8")
const words = denylist.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("/"))
assert.ok(words.length >= 7, "the denylist reads as words")
for (const word of words) {
  assert.deepEqual(kinds(`runs on ${word} today`), ["hosted name"], word)
  assert.deepEqual(kinds(`Runs on ${word.toUpperCase()}.`), ["hosted name"], word)
  assert.deepEqual(kinds(`runs on x${word}y`), [], `${word} inside a word`)
}
assert.deepEqual(kinds("stored in R2 and served from x.r2.dev"), ["hosted name", "hosted name"])
assert.deepEqual(kinds("const [a2, r2] = pair; ref r2"), [])
assert.deepEqual(denylistPatterns("# note\n\nalpha\n/Be+ta/\n").map((pattern) => pattern.flags), ["gi", "g"])
assert.deepEqual(findLeaks("a column at 9: /Users/jordan"), [{ column: 16, kind: "home path" }])

// A diff's added lines by their hunk's counts: a line that starts with "+++" is content, and context lines count.
const diff = [
  "diff --git a/a.md b/a.md",
  "--- a/a.md",
  "+++ b/a.md",
  "@@ -1,2 +1,3 @@",
  " kept",
  "-gone",
  "+++ added, not a header",
  "+second",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+only",
  "\\ No newline at end of file",
].join("\n")
assert.deepEqual(addedLines(diff), {
  lines: [
    { file: "a.md", index: 1, line: 2, text: "++ added, not a header" },
    { file: "a.md", index: 1, line: 3, text: "second" },
    { file: "new.txt", index: 2, line: 1, text: "only" },
  ],
  files: [{ file: "new.txt", index: 2 }],
})

// The check itself, in a scratch repository: it trips on what a change adds, by place and kind, and never prints it.
const root = await mkdtemp(join(tmpdir(), "mako-public-text-"))
const check = fileURLToPath(new URL("check-public-text.mjs", import.meta.url))
const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const write = async (path, text) => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}
const commit = async (files, message) => {
  for (const [path, text] of Object.entries(files)) await write(path, text)
  run(["add", "-A"])
  run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", message])
  return run(["rev-parse", "HEAD"])
}
const cli = (base, head) => spawnSync(process.execPath, [check, base, head], { cwd: root, encoding: "utf8" })
try {
  run(["init", "-q", "-b", "main"])
  const base = await commit({ "docs/old.md": "Built in /Users/jordan/app once.\n", "README.md": "# Fixture\n" }, "Start")

  const clean = await commit({ "docs/note.md": "Built in /Users/someone/app, see $TMPDIR/run and a@example.com.\n" }, "A clean note")
  const passed = cli(base, clean)
  assert.equal(passed.status, 0, passed.stderr)
  assert.deepEqual(changeLeaks(base, clean, { cwd: root }), [])

  const planted = await commit({ "docs/note.md": "Built in /Users/someone/app.\nThen in /Users/jordan/app.\n" }, "Plant a home path")
  const failed = cli(base, planted)
  assert.equal(failed.status, 1, "a planted home path fails the check")
  assert.match(failed.stderr, /docs\/note\.md:2:9: home path/)
  assert.doesNotMatch(failed.stderr + failed.stdout, /jordan/, "the value is never printed")

  // Only what the change adds: a removed or kept line that holds one passes.
  const removed = await commit({ "docs/old.md": "Built once.\n", "docs/note.md": "Built in /Users/someone/app.\n" }, "Remove it again")
  assert.deepEqual(changeLeaks(planted, removed, { cwd: root }), [])

  const message = await commit({ "docs/x.md": "x\n" }, "Fix the build\n\nRan it from /var/folders/ab/xyz/T/run.")
  const short = run(["rev-parse", "--short", "HEAD"])
  assert.deepEqual(changeLeaks(removed, message, { cwd: root }), [`commit ${short}, message line 3:13: temporary folder`])

  // A pull request's title and body come from its event's file, which nothing prints.
  const event = `${root}-event.json`
  await writeFile(event, JSON.stringify({ pull_request: { base: { sha: message }, head: { sha: message }, title: "Moves to wrangler", body: "Thanks!\nReach me at jordan@gmail.com" } }))
  const body = spawnSync(process.execPath, [check, "--event", event], { cwd: root, encoding: "utf8" })
  await rm(event, { force: true })
  assert.equal(body.status, 1)
  assert.match(body.stderr, /pull request title, line 1:10: hosted name/)
  assert.match(body.stderr, /pull request body, line 2:13: email/)
  assert.doesNotMatch(body.stderr, /jordan|wrangler/)

  const named = await commit({ "scripts/axiom-setup.sh": "echo\n" }, "A new file named for a vendor")
  assert.deepEqual(changeLeaks(message, named, { cwd: root }), ["file #1 (name withheld), its name: hosted name"])

  // A name that holds a value is withheld wherever it would locate a finding, by its place in `git diff --name-only`.
  const leakyName = await commit({
    "docs/a-clean.md": "clean\n",
    "docs/jordan@gmail.com/notes.md": "clean\n",
    "docs/-Users-jordan-app.md": "Built in /home/jordan/app\n",
  }, "Files whose names hold values")
  const leakyOut = cli(named, leakyName)
  assert.equal(leakyOut.status, 1)
  const listed = run(["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", `${named}...${leakyName}`]).split("\n")
  assert.deepEqual(listed.map((file, at) => `${at + 1} ${file}`), ["1 docs/-Users-jordan-app.md", "2 docs/a-clean.md", "3 docs/jordan@gmail.com/notes.md"])
  assert.deepEqual(changeLeaks(named, leakyName, { cwd: root }), [
    "file #1 (name withheld), its name: home path",
    "file #3 (name withheld), its name: email",
    "file #1 (name withheld):1:10: home path",
  ])
  assert.doesNotMatch(leakyOut.stdout + leakyOut.stderr, /jordan|gmail/, "neither a name nor a line's value is printed")
  assert.match(leakyOut.stderr, /file #N is line N of `git diff --name-only --no-renames /)

  // A name the file exceptions let through is withheld all the same: what a line may hold, a log may not repeat.
  const suffixed = await commit({
    "docs/jordan@gmail.com.md": "Reach jordan@gmail.com\n",
    "Users/jordan/notes.md": "clean\n",
    "home/jordan.jsonl/notes.md": "Built in /home/jordan/app\n",
    "home/jordan.md": "Built in /home/jordan/app\n",
    "native-1@launch-1.jsonl": "Built in /home/jordan/app\n",
  }, "Files whose names read as files'")
  const suffixedOut = cli(leakyName, suffixed)
  assert.equal(suffixedOut.status, 1)
  assert.deepEqual(changeLeaks(leakyName, suffixed, { cwd: root }), [
    "file #1 (name withheld), its name: home path",
    "file #3 (name withheld), its name: home path",
    "file #2 (name withheld):1:7: email",
    "file #3 (name withheld):1:10: home path",
    "file #4 (name withheld):1:10: home path",
    "file #5 (name withheld):1:10: home path",
  ])
  assert.doesNotMatch(suffixedOut.stdout, /jordan|gmail|launch/)
  assert.doesNotMatch(suffixedOut.stderr, /jordan|gmail|launch/, "stderr, which CI prints, holds no name either")

  // What only reads like a leak passes the check whole: a leaf file, a remote, an address that's a file's name.
  const legitimate = await commit({ "docs/kept.md": "/home/pace.jsonl\ngit@github.com:Verbiflow/mako.git\nssh://git@github.com/Verbiflow/mako.git\nnative-1@launch-1.jsonl\n", "icon@2x.png": "x\n" }, "What only reads like a leak")
  const legitimateOut = cli(suffixed, legitimate)
  assert.equal(legitimateOut.status, 0, legitimateOut.stderr)

  // And what the file and remote exceptions must not cover fails through the check itself, its value unprinted.
  const exceptions = await commit({ "docs/gaps.md": "Built in /home/jordan.jsonl/work/app\nMail git@jordan-family.com\n" }, "What reads like a file or a remote")
  const exceptionsOut = cli(legitimate, exceptions)
  assert.equal(exceptionsOut.status, 1)
  assert.match(exceptionsOut.stderr, /docs\/gaps\.md:1:10: home path\n\s+docs\/gaps\.md:2:6: email/)
  assert.doesNotMatch(exceptionsOut.stdout + exceptionsOut.stderr, /jordan/)

  // npm writes a lockfile, with the addresses packages publish; anything else in it still counts.
  const locked = await commit({ "package-lock.json": '{ "author": "jordan@gmail.com",\n  "home": "/Users/jordan" }\n' }, "Lock a dependency")
  assert.deepEqual(changeLeaks(exceptions, locked, { cwd: root }), ["package-lock.json:2:12: home path"])

  // The denylist and this test spell what they check for.
  const exempt = await commit({ "scripts/public-text-denylist.txt": "axiom\n", "scripts/test-public-text.mjs": "// /Users/jordan\n" }, "The guard's own files")
  assert.deepEqual(changeLeaks(locked, exempt, { cwd: root }), [])
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("public text check: home paths, temporary folders, addresses and hosted names trip it; placeholders pass")
