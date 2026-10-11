import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FolderWatches } from "../dist/root-watch.js"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-root-watch-")))
const until = async (check, what) => {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(what)
}
try {
  await mkdir(join(root, "2026", "09", "27"), { recursive: true })
  await mkdir(join(root, "project", "session", "subagents"), { recursive: true })
  for (let index = 0; index < 50; index++) await writeFile(join(root, "2026", "09", "27", `rollout-${index}.jsonl`), "{}\n")
  await writeFile(join(root, "project", "session.jsonl"), "{}\n")
  // FSEvents delivers writes from just before a watch starts; this watch is
  // Linux's, where inotify never does.
  if (process.platform === "darwin") await new Promise((resolve) => setTimeout(resolve, 1000))

  const heard = []
  let failed = false
  const folders = new FolderWatches()
  const watch = folders.watchFolders(root, (path) => heard.push(path), () => { failed = true })
  await until(() => folders.count === 7, "every folder is watched")
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(heard, [], "files already there aren't reported: discovery has them")

  await appendFile(join(root, "2026", "09", "27", "rollout-7.jsonl"), "{}\n")
  await until(() => heard.includes(join(root, "2026", "09", "27", "rollout-7.jsonl")), "a write three folders down is heard")
  await writeFile(join(root, "project", "session", "subagents", "agent-1.jsonl"), "{}\n")
  await until(() => heard.includes(join(root, "project", "session", "subagents", "agent-1.jsonl")), "a new file in a deep folder is heard")

  // A day folder and its first rollout, written before the watch reaches it.
  await mkdir(join(root, "2026", "09", "28", "late"), { recursive: true })
  await writeFile(join(root, "2026", "09", "28", "late", "rollout-first.jsonl"), "{}\n")
  await until(() => heard.includes(join(root, "2026", "09", "28", "late", "rollout-first.jsonl")), "a file in a new folder is heard even when written first")
  await until(() => folders.count === 9, "new folders are watched")
  await writeFile(join(root, "2026", "09", "28", "late", "rollout-second.jsonl"), "{}\n")
  await until(() => heard.includes(join(root, "2026", "09", "28", "late", "rollout-second.jsonl")), "and later writes in it")

  await rm(join(root, "2026", "09", "28"), { recursive: true })
  await until(() => folders.count === 7, "a removed folder gives its watches back")
  assert.equal(failed, false)
  watch.close()
  assert.equal(folders.count, 0, "closing gives every watch back")

  const small = new FolderWatches(3)
  const partial = small.watchFolders(root, () => {}, () => { failed = true })
  await until(() => small.count === 3, "the budget's folders are watched")
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(small.count, 3, "and no more")
  assert.equal(folders.count, 0, "each catalog's watches count against its own budget")
  partial.close()
  assert.equal(small.count, 0)
  console.log("root watch: folders only, nothing for files already there, deep writes heard, new folders walked, removed folders released, a budget kept")
} finally {
  await rm(root, { recursive: true, force: true })
}
