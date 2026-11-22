import assert from "node:assert/strict"
import { test } from "node:test"
import { AbsolutePathSchema, keptPath } from "@mako/protocol/attribution"
import { absoluteFrom, absolutePath, folderOf, insideOf, joined, nameOf, normalizedPath, partsOf, under, within } from "@mako/host/base/path-style"
import { absolutePath as callPath } from "@mako/sessions/tool-effect-reading"
import { otherAppsData } from "@mako/host/base/other-apps-data"

// Paths in the record of changes on a Mac, Linux and Windows (`base/path-style.ts`). Each path says its own style, so
// these run the same on every system: a Windows path is handled as Windows writes it on a Mac too, and a path from `/`
// comes out byte for byte as it went in.

test("a path from / is kept, joined, split and compared exactly as before", () => {
  for (const path of ["/Users/ana/site", "/", "//server/share/x", "/a b/c\\d", "/tmp/x/"]) assert.equal(keptPath(path), path)
  assert.equal(AbsolutePathSchema.parse("/Users/ana/site/"), "/Users/ana/site/")
  assert.equal(under("/w/site", "src/app.ts"), "/w/site/src/app.ts")
  assert.equal(insideOf("/w/site", "/w/site/src/app.ts"), "src/app.ts")
  assert.equal(insideOf("/w/site", "/w/site/a\\b.ts"), "a\\b.ts", "a backslash in a name stays a name")
  assert.ok(within("/w/site", "/w/site") && within("/w/site", "/w/site/a") && !within("/w/site", "/w/sites/a") && !within("/w/site", "/W/site/a"))
  assert.deepEqual(partsOf("/w/site/a.ts"), ["", "w", "site", "a.ts"])
  assert.equal(folderOf("/w/site/a.ts"), "/w/site")
  assert.equal(folderOf("/"), "/")
  assert.equal(nameOf("/w/site/a.ts"), "a.ts")
  assert.equal(joined("/w/site", "..", "x"), "/w/x")
  assert.equal(normalizedPath("/w//site/./a/../b"), "/w/site/b")
  assert.equal(absoluteFrom("/w/site", "src/a.ts"), "/w/site/src/a.ts")
  assert.equal(absoluteFrom("/w/site", "/etc/hosts"), "/etc/hosts")
  assert.equal(absoluteFrom(undefined, "src/a.ts"), undefined)
  assert.equal(callPath("src/../a.ts", "/w/site"), "/w/site/a.ts")
  assert.equal(callPath("https://example.com/a", "/w/site"), undefined)
  assert.equal(callPath("~/a", "/w/site"), undefined)
})

test("a Windows path is one folder however a harness, Git or the system wrote it", () => {
  for (const written of ["C:\\Users\\ana\\site", "C:/Users/ana/site", "c:\\Users\\ana\\site", "c:/Users/ana/site/", "C:\\Users\\ana\\site\\"]) assert.equal(keptPath(written), "C:\\Users\\ana\\site")
  assert.equal(keptPath("C:\\"), "C:\\")
  assert.equal(keptPath("\\\\server\\share\\x"), "\\\\server\\share\\x")
  assert.equal(AbsolutePathSchema.parse("c:/Users/ana/site"), "C:\\Users\\ana\\site")
  assert.equal(AbsolutePathSchema.safeParse("Users/ana").success, false)
  assert.equal(AbsolutePathSchema.safeParse("C:site").success, false, "a drive's current folder is no absolute path")
  assert.ok(absolutePath("C:\\x") && absolutePath("C:/x") && absolutePath("/x") && !absolutePath("x\\y"))
})

test("inside a Windows root a path is /-separated, and names are compared as Windows compares them", () => {
  const root = "C:\\Users\\ana\\site"
  assert.equal(under(root, "src/app.ts"), "C:\\Users\\ana\\site\\src\\app.ts")
  assert.equal(insideOf(root, "C:\\Users\\ana\\site\\src\\app.ts"), "src/app.ts")
  assert.ok(within(root, root) && within(root, "C:\\Users\\ana\\site\\a") && within(root, "c:\\users\\ANA\\Site\\a"))
  assert.ok(!within(root, "C:\\Users\\ana\\sites\\a") && !within(root, "D:\\Users\\ana\\site\\a"))
  assert.deepEqual(partsOf("C:\\w\\a.ts"), ["C:", "w", "a.ts"])
  assert.equal(folderOf("C:\\w\\a.ts"), "C:\\w")
  assert.equal(folderOf("C:\\"), "C:\\", "a drive is its own folder")
  assert.equal(nameOf("C:\\w\\a.ts"), "a.ts")
  assert.equal(joined("C:\\w\\site", "..", "x"), "C:\\w\\x")
  assert.equal(absoluteFrom("C:\\w\\site", "src/a.ts"), "C:\\w\\site\\src\\a.ts")
  assert.equal(absoluteFrom("C:\\w\\site", "..\\other\\a.ts", "resolve"), "C:\\w\\other\\a.ts")
  assert.equal(absoluteFrom("C:\\w\\site", "d:/x/a.ts"), "D:\\x\\a.ts")
})

test("a tool call's path on Windows: a drive's path is no URL, and a name is read from the call's folder", () => {
  assert.equal(callPath("C:\\w\\site\\a.ts", undefined), "C:\\w\\site\\a.ts")
  assert.equal(callPath("c:/w/site/./src/../a.ts", undefined), "C:\\w\\site\\a.ts")
  assert.equal(callPath("src\\a.ts", "C:\\w\\site"), "C:\\w\\site\\src\\a.ts")
  assert.equal(callPath("../a.ts", "C:/w/site"), "C:\\w\\a.ts")
  assert.equal(callPath("..\\..\\..\\a.ts", "C:\\w"), "C:\\a.ts", "never above its drive")
  assert.equal(callPath("file:///C:/w/site/a%20b.ts", undefined), "C:\\w\\site\\a b.ts")
  assert.equal(callPath("\\\\server\\share\\x\\..\\a.ts", undefined), "\\\\server\\share\\a.ts")
  assert.equal(callPath("https://example.com/a", "C:\\w"), undefined)
  assert.equal(callPath("a.ts", undefined), undefined)
})

test("macOS's containers are found by the home folder's own separator", () => {
  assert.equal(otherAppsData("/h/Library/Containers/com.example.notes/Data/a.json", "/h", "darwin"), "/h/Library/Containers/com.example.notes")
  assert.equal(otherAppsData("C:\\Users\\ana\\Documents\\a.txt", "C:\\Users\\ana", "win32"), undefined)
})
