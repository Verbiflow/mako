import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { z } from "zod"
import { PAGE_FIT_SCRIPT } from "@mako/host/contracts/page-frame"
import { deskPreviewFile, resolveDeskPreviewUrl } from "@mako/host/contracts/desk-url"
import { encodeRuntimeValue, decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { OwnerFiles } from "@mako/host/conversations/owner-files"
import { runtimeFile } from "@mako/host/transport/connection"
import { ownedFilePreviewUrl, verifyFilePreview, type FileOwner } from "@mako/host/workspaces/file-previews"
import { readSignedFile, readWindowFile } from "@mako/host/workspaces/file-readers"
import { MediaRenditions } from "@mako/host/workspaces/media-renditions"
import { OwnedFiles, ownerFileRead } from "@mako/host/workspaces/owned-files"

/**
 * A picture, recording or page another host read, served by this one: a cloud Thread's machine, another device, or
 * another host on this Mac each sign their URLs with a secret of their own, which this host can't verify. The owner
 * here is a process of its own (`lib/owned-files-owner.ts`), so its secret is truly another's.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-owned-files-")))
after(() => rm(root, { recursive: true, force: true }))
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=", "base64")
const files = join(root, "owner")
await mkdir(files, { recursive: true })
await writeFile(join(files, "shot.png"), PNG_1x1)
await writeFile(join(files, "other.png"), Buffer.concat([PNG_1x1, Buffer.alloc(16)]))
await writeFile(join(files, "page.html"), "<!doctype html><html><head><link rel=stylesheet href=style.css></head><body>hi</body></html>")
await writeFile(join(files, "style.css"), "body { color: red }")
const socket = join(root, "owner.sock")
const owner = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "lib", "owned-files-owner.ts"), socket, join(root, "owner-renditions")], { stdio: ["ignore", "pipe", "inherit"] })
after(() => owner.kill())
await once(owner.stdout, "data")

const renditions = new MediaRenditions({ folder: join(root, "renditions"), ffmpeg: () => "ffmpeg-not-here" })
const here: FileOwner = { kind: "socket", socket }

/** The owner's own signed URL for one of its files. */
async function signed(name: string): Promise<string> {
  const response = await new Promise<string>((resolve, reject) => {
    const asked = request({ socketPath: socket, path: `/sign?path=${encodeURIComponent(join(files, name))}` }, (reply) => {
      let text = ""
      reply.on("data", (chunk: Buffer) => (text += chunk))
      reply.on("end", () => resolve(text))
    })
    asked.on("error", reject)
    asked.end()
  })
  return z.object({ previewUrl: z.string() }).parse(JSON.parse(response)).previewUrl
}

/** A copy kept here for the owner, fetched through what's counted. */
function ownedFiles(folder: string, keptBytes?: number) {
  const fetched: string[] = []
  const ownerFiles = new OwnerFiles({ gateway: () => undefined, token: async () => undefined })
  const owned = new OwnedFiles({
    folder: join(root, folder),
    fetch: (who, url, init) => {
      fetched.push(url)
      return ownerFiles.fetch(who, url, init)
    },
    ...keptBytes !== undefined && { keptBytes },
  })
  return { owned, fetched }
}

/** A file read as the owner answered it, as this host hands it to its windows. */
function read(previewUrl: string, more: Record<string, string> = {}) {
  const value = ownerFileRead(here, encodeRuntimeValue({ path: "/elsewhere/shot.png", size: PNG_1x1.length, binary: true, truncated: false, media: "image", mimeType: "image/png", previewUrl, ...more }))
  return z.object({ path: z.string(), previewUrl: z.string(), thumbnailUrl: z.string().optional() }).loose().parse(decodeRuntimeValue(value))
}

test("another host's picture loads here: refused as its owner signed it, served once signed here for that owner, kept by what it is", async () => {
  const { owned, fetched } = ownedFiles("kept")
  const theirs = await signed("shot.png")
  assert.equal((await verifyFilePreview(theirs)).kind, "invalid", "this host can't verify another host's URL: the broken picture")
  const broken = await readSignedFile(new Request(theirs), renditions, owned)
  assert.equal(broken.status, 404)
  await broken.body?.cancel()

  const file = read(theirs)
  assert.equal(file.path, "/elsewhere/shot.png", "the rest of the read is the owner's")
  assert.notEqual(file.previewUrl, theirs)
  assert.ok(file.previewUrl.startsWith("mako-file://asset/"), "a URL every client of this host already loads, the gateway's link included")
  const loaded = await readSignedFile(new Request(file.previewUrl), renditions, owned)
  assert.equal(loaded.status, 200)
  assert.equal(loaded.headers.get("content-type"), "image/png")
  assert.deepEqual(Buffer.from(await loaded.arrayBuffer()), PNG_1x1)
  assert.equal(fetched.length, 1)

  // The desk window loads it on its own origin; the URL comes back whole.
  const desk = resolveDeskPreviewUrl(file.previewUrl, "mako-app://desk/index.html", "00000000-0000-4000-8000-000000000000")
  const back = deskPreviewFile(desk)!
  const window = await readWindowFile(new Request(back), async () => assert.fail("no workspace path is read"), renditions, owned)
  assert.equal(window.status, 200)
  await window.body?.cancel()

  // A part of it, as a video's player asks: from the copy, not the owner again.
  const part = await readSignedFile(new Request(file.previewUrl, { headers: { range: "bytes=0-7" } }), renditions, owned)
  assert.equal(part.status, 206)
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), PNG_1x1.subarray(0, 8))
  // Read again, under a new signature: the same file, so the same copy.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const again = read(await signed("shot.png"))
  assert.notEqual(again.previewUrl, file.previewUrl)
  const reloaded = await readSignedFile(new Request(again.previewUrl), renditions, owned)
  assert.equal(reloaded.status, 200)
  await reloaded.body?.cancel()
  assert.equal(fetched.length, 1, "the window's load, the range and the new signature all read the first load's copy")

  // Two windows loading it at once fetch it once.
  const { owned: fresh, fetched: once } = ownedFiles("at-once")
  const both = await Promise.all([1, 2].map(() => readSignedFile(new Request(file.previewUrl), renditions, fresh)))
  assert.deepEqual(both.map((response) => response.status), [200, 200])
  await Promise.all(both.map((response) => response.arrayBuffer()))
  assert.equal(once.length, 1)
})

test("a file its owner no longer has says so, and nothing is kept: it's asked again the next time", async () => {
  const { owned, fetched } = ownedFiles("gone")
  await writeFile(join(files, "gone.png"), PNG_1x1)
  const file = read(await signed("gone.png"))
  await rm(join(files, "gone.png"))
  const answer = await readSignedFile(new Request(file.previewUrl), renditions, owned)
  assert.equal(answer.status, 403)
  assert.match(await answer.text(), /changed/)
  const second = await readSignedFile(new Request(file.previewUrl), renditions, owned)
  assert.equal(second.status, 403)
  await second.body?.cancel()
  assert.equal(fetched.length, 2)
  assert.deepEqual(await readdir(join(root, "gone")).catch(() => []), [])
})

test("another host's page loads with its assets, fitted once, by the owner", async () => {
  const { owned } = ownedFiles("page")
  const file = read(await signed("page.html"))
  const page = await readSignedFile(new Request(file.previewUrl), renditions, owned)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get("content-type"), "text/html")
  const html = await page.text()
  assert.equal(html.split(PAGE_FIT_SCRIPT).length - 1, 1, "the owner fitted it; this host keeps it as it came")
  const asset = await readSignedFile(new Request(file.previewUrl.replace(/page\.html$/, "style.css")), renditions, owned)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get("content-type"), "text/css")
  assert.equal(asset.headers.get("access-control-allow-origin"), "*")
  assert.equal(await asset.text(), "body { color: red }")
  const outside = await readSignedFile(new Request(file.previewUrl.replace(/page\.html$/, "..%2Fowner.sock")), renditions, owned)
  assert.notEqual(outside.status, 200)
  await outside.body?.cancel()
})

test("a thumbnail is asked of the owner as asked here, and kept apart from the picture", async () => {
  const { owned, fetched } = ownedFiles("thumbs")
  const theirs = await signed("other.png")
  const file = read(theirs, { thumbnailUrl: `${theirs}?rendition=thumbnail` })
  assert.ok(file.thumbnailUrl?.endsWith("?rendition=thumbnail"))
  for (const url of [file.previewUrl, file.thumbnailUrl!]) {
    const answer = await readSignedFile(new Request(url), renditions, owned)
    assert.equal(answer.status, 200)
    await answer.body?.cancel()
  }
  assert.deepEqual(fetched.map((url) => new URL(url).search), ["", "?rendition=thumbnail"])
})

test("a URL signed here for an owner ends as the owner's does, and one changed on the way is refused", async () => {
  const theirs = await signed("shot.png")
  const ended = ownedFilePreviewUrl(here, theirs, { now: Date.now() - 2 * 60 * 60_000 })!
  assert.deepEqual(await verifyFilePreview(ended), { kind: "refused", reason: "expired" })
  const ours = ownedFilePreviewUrl(here, theirs)!
  const [, , , payload, signature] = ours.split("/")
  const tampered = ours.replace(signature!, signature!.replace(/^./, (first) => (first === "a" ? "b" : "a")))
  assert.deepEqual(await verifyFilePreview(tampered), { kind: "invalid" })
  const otherOwner = Buffer.from(JSON.stringify(["owned", "socket", "/elsewhere.sock", ...JSON.parse(Buffer.from(payload!, "base64url").toString()).slice(3)])).toString("base64url")
  assert.deepEqual(await verifyFilePreview(ours.replace(payload!, otherOwner)), { kind: "invalid" }, "the owner is part of what's signed")
  assert.equal(ownedFilePreviewUrl(here, "https://example.com/shot.png"), undefined)
  assert.equal(ownedFilePreviewUrl(here, "mako-file://workspace/shot.png"), undefined)
})

test("a cloud Thread's and another device's files come through the address the gateway gives for them, asked once a while", async () => {
  const asked: Array<{ url: string; body?: unknown; authorization?: string | null }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if (url.endsWith("/v1/previews")) {
      const body: unknown = JSON.parse(String(init?.body))
      asked.push({ url, body, authorization: headers.get("authorization") })
      const thread = z.object({ threadId: z.string() }).safeParse(body).success
      return Response.json({ url: thread ? "https://p-thread.files.test/" : "https://p-device.files.test", expiresAt: Date.now() + 3_600_000 })
    }
    asked.push({ url })
    // The address serves the owner's signed files through its link, as the owner's host answers them.
    const rest = new URL(url).pathname.replace(/^\/file\//, "")
    return runtimeFile(socket, new Request(`mako-file://${rest}`, { headers }))
  }
  let token: string | undefined = "device-token"
  const ownerFiles = new OwnerFiles({ gateway: () => new URL("https://gateway.test"), token: async () => token, fetch: fakeFetch })
  const owned = new OwnedFiles({ folder: join(root, "gateway"), fetch: (who, url, init) => ownerFiles.fetch(who, url, init) })
  const thread: FileOwner = { kind: "thread", threadId: "t-0123456789abcdef" }
  const device: FileOwner = { kind: "device", deviceId: "4d2b8c1e-7a3f-4e5d-9b6c-0a1f2e3d4c5b" }
  for (const [who, name] of [[thread, "shot.png"], [thread, "other.png"], [device, "shot.png"]] as const) {
    const url = ownedFilePreviewUrl(who, await signed(name))!
    const answer = await readSignedFile(new Request(url), renditions, owned)
    assert.equal(answer.status, 200, `${who.kind} ${name}`)
    await answer.body?.cancel()
  }
  const grants = asked.filter((entry) => entry.body !== undefined)
  assert.deepEqual(grants.map((entry) => entry.body), [{ threadId: "t-0123456789abcdef", files: true }, { deviceId: "4d2b8c1e-7a3f-4e5d-9b6c-0a1f2e3d4c5b", files: true }], "one address for each owner, kept for its files")
  assert.ok(grants.every((entry) => entry.authorization === "Bearer device-token"))
  const loads = asked.filter((entry) => entry.body === undefined).map((entry) => new URL(entry.url))
  assert.deepEqual(loads.map((url) => url.host), ["p-thread.files.test", "p-thread.files.test", "p-device.files.test"])
  assert.ok(loads.every((url) => url.pathname.startsWith("/file/asset/")))

  // Signed out: the picture says its computer couldn't be reached, rather than drawing nothing.
  token = undefined
  const signedOut = new OwnedFiles({ folder: join(root, "signed-out"), fetch: (who, url, init) => new OwnerFiles({ gateway: () => new URL("https://gateway.test"), token: async () => token, fetch: fakeFetch }).fetch(who, url, init) })
  const unreachable = await readSignedFile(new Request(ownedFilePreviewUrl(thread, await signed("shot.png"))!), renditions, signedOut)
  assert.equal(unreachable.status, 502)
  assert.match(await unreachable.text(), /couldn't be reached/)
})

test("the copies stay under their bound, the least recently loaded going first", async () => {
  const { owned } = ownedFiles("bounded", PNG_1x1.length + 20)
  for (const name of ["shot.png", "other.png"]) {
    const answer = await readSignedFile(new Request(read(await signed(name)).previewUrl), renditions, owned)
    assert.equal(answer.status, 200)
    await answer.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const deadline = Date.now() + 2_000
  while ((await readdir(join(root, "bounded"))).length > 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  const left = await readdir(join(root, "bounded"))
  assert.equal(left.length, 1)
  const kept = await readdir(join(root, "bounded", left[0]!))
  assert.deepEqual(kept, ["other.png"])
  assert.deepEqual(await readFile(join(root, "bounded", left[0]!, "other.png")), Buffer.concat([PNG_1x1, Buffer.alloc(16)]))
})
