import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

async function exists(path) {
  return lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null
    throw error
  })
}

/** Install immutable versions; only the launcher changes for subsequent processes. */
export async function installControlDriver({
  source,
  root,
  link,
  version,
  binarySha256,
  verify,
}) {
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+\+mako\.[0-9]+$/)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(dirname(link), { recursive: true })
  const lock = join(root, ".install-lock")
  const owner = randomUUID()
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `A driver installation owns ${lock}. An interrupted installation leaves this lock for inspection; it is not removed automatically.`
      )
    throw error
  }
  const token = join(lock, "owner.json")
  const pending = `${link}.${owner}.tmp`
  const stage = join(root, `.stage-${owner}.app`)
  const versionRoot = join(root, version)
  const app = join(versionRoot, "CuaDriverLocal.app")
  const binary = join(app, "Contents/MacOS/cua-driver")
  const receipt = join(versionRoot, "installation.json")
  let tokenWritten = false
  try {
    await writeFile(
      token,
      JSON.stringify({ owner, pid: process.pid, version }),
      { flag: "wx", mode: 0o600 }
    )
    tokenWritten = true
    const entry = await exists(link)
    assert.ok(
      !entry || entry.isSymbolicLink(),
      "Refusing to replace an unmanaged cua-driver executable"
    )
    const previous = entry ? await readlink(link) : null
    if (previous) {
      const managed = relative(root, previous).split(sep)
      assert.ok(
        previous === "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" ||
          previous ===
            "/Applications/CuaDriverLocal.app/Contents/MacOS/cua-driver" ||
          (managed.length === 5 &&
            /^[0-9]+\.[0-9]+\.[0-9]+\+mako\.[0-9]+$/.test(managed[0]) &&
            managed.slice(1).join("/") ===
              "CuaDriverLocal.app/Contents/MacOS/cua-driver"),
        "Refusing to replace an unrecognized driver selection"
      )
    }
    await verify(source)
    if (await exists(app)) await verify(app)
    else {
      await cp(source, stage, {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
      await verify(stage)
      await mkdir(versionRoot, { recursive: true, mode: 0o700 })
      await rename(stage, app)
    }
    let rollback = previous
    if (previous === binary) {
      const prior = await readFile(receipt, "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === "ENOENT") return null
          throw error
        })
      if (prior?.binarySha256 === binarySha256) rollback = prior.previous
    }
    const record = {
      app,
      link,
      previous: rollback,
      version,
      binarySha256,
      state: "prepared",
      activatedAt: new Date().toISOString(),
    }
    const save = async () => {
      const temp = `${receipt}.${owner}.tmp`
      await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
      await rename(temp, receipt)
    }
    await save()
    if (previous !== binary) {
      await symlink(binary, pending)
      await rename(pending, link)
    }
    assert.equal(await readlink(link), binary)
    record.state = "selected"
    await save()
    return { ...record, receipt, binary }
  } finally {
    await rm(pending, { force: true })
    await rm(stage, { force: true, recursive: true })
    if (
      tokenWritten &&
      JSON.parse(await readFile(token, "utf8")).owner === owner
    )
      await rm(lock, { recursive: true })
  }
}
