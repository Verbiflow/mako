import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const home = realpathSync(mkdtempSync(join(tmpdir(), "mako-chat-folders-")))
process.env.HOME = home
const { chatFolders, chatsRoot, discardChatFolder, newChatFolder, standsForNoProject } = await import("../electron/chat-folders.ts")
const { discoverRepositories } = await import("../electron/repository-discovery.ts")
const { defaultWorkspace } = await import("../electron/host.ts")

try {
  const root = join(home, "Mako", "Chats")
  assert.equal(chatsRoot(), root)

  assert.equal(standsForNoProject("/"), true, "the Dock's working directory is no project")
  assert.equal(standsForNoProject(""), true)
  assert.equal(standsForNoProject(root), true)
  assert.equal(standsForNoProject(home), false, "a home folder someone opened on purpose stays theirs")
  assert.equal(standsForNoProject(join(root, "2026-09-27-4f1c2a")), false, "an existing chat keeps its folder")

  const at = new Date(2026, 8, 27, 23, 50)
  const first = newChatFolder(at)
  const second = newChatFolder(at)
  assert.equal(dirname(first), root)
  assert.match(basename(first), /^2026-09-27-[0-9a-f]{6}$/)
  assert.notEqual(first, second, "two chats started the same minute get two folders")
  assert.ok(existsSync(first) && existsSync(second))

  assert.deepEqual(chatFolders([first, `${second}/notes`, "/elsewhere"]), { root, projects: [] })
  mkdirSync(join(second, ".git"))
  assert.deepEqual(chatFolders([first, `${second}/notes`, "/elsewhere"]), { root, projects: [second] }, "git init makes a chat a project")

  discardChatFolder(first)
  assert.equal(existsSync(first), false, "a refused start gives back its empty folder")
  writeFileSync(join(second, "notes.md"), "kept")
  discardChatFolder(second)
  assert.equal(existsSync(second), true, "a folder with anything in it stays")

  assert.deepEqual(await discoverRepositories(root), { roots: [], limited: false }, "the Chats folder isn't searched for repositories")
  assert.deepEqual(await discoverRepositories(home), { roots: [], limited: false }, "nor the home folder")
  assert.deepEqual(await discoverRepositories("/"), { roots: [], limited: false }, "nor the disk")

  const launched = process.cwd()
  try {
    process.chdir("/")
    assert.equal(defaultWorkspace(), root, "an app opened from the Dock opens the Chats folder")
    process.chdir(home)
    assert.equal(defaultWorkspace(), root)
  } finally {
    process.chdir(launched)
  }
  assert.equal(defaultWorkspace(), launched, "a host started from a folder opens it")

  console.log("Chat folders: the Dock's / and the Chats folder start a folder per chat, git init promotes one, empty folders are given back, and no repository search walks /, home or Chats")
} finally {
  rmSync(home, { recursive: true, force: true })
}
