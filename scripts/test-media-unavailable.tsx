import assert from "node:assert/strict"
import { createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { InlineMedia } from "../src/components/transcript/inline-media"
import { MediaUnavailable } from "../src/components/transcript/media-preview"

/**
 * A picture an answer names that can't be shown says why, and where it was looked for, in a grid's tile as on its
 * own: never a blank tile with a broken icon and the picture's caption.
 */

const missing = "/tmp/mako-control-artifacts/shot.png"
const tile = { kind: "tile", aspect: 16 / 10 } as const
const draw = (error: string, path = missing) => renderToStaticMarkup(
  <InlineMedia hostRef={createRef()} path={path} name="Sign-in page: headline" format="image" error={error} tile={tile} openPath={path} onRetry={() => {}} onMediaError={() => {}} />,
)

const gone = draw(`No file at ${missing}`)
assert.match(gone, /data-media-unavailable/)
assert.match(gone, /Sign-in page: headline/)
assert.match(gone, />No file at \/tmp\/mako-control-artifacts\/shot\.png</, "the reason, which names the file")
assert.doesNotMatch(gone, /<bdi>/, "a reason that names the file isn't followed by it again")

const unloaded = draw("The preview didn't load")
assert.match(unloaded, /The preview didn&#x27;t load/)
assert.match(unloaded, /<bdi>\/tmp\/mako-control-artifacts\/shot\.png<\/bdi>/, "a reason that doesn't name the file has its path beside it")

const card = renderToStaticMarkup(<MediaUnavailable name="shot.png" reason="The computer that has it couldn't be reached" path={missing} />)
assert.match(card, /couldn&#x27;t be reached/)
assert.match(card, /<bdi>\/tmp\/mako-control-artifacts\/shot\.png<\/bdi>/)
const named = renderToStaticMarkup(<MediaUnavailable name="shot.png" reason={`No file at ${missing}`} path={missing} />)
assert.doesNotMatch(named, /<bdi>/, "a reason that names the file isn't followed by it again")

// A large picture alone draws the rendition that fills its box, never the original, which is the lightbox's; in a
// grid it draws the tile's thumbnail. A picture the host offers no rendition of draws as it is.
const large = { path: "shot.png", contents: "", size: 1, binary: true, truncated: false, mimeType: "image/png", previewUrl: "mako-file://asset/p/s/shot.png", thumbnailUrl: "mako-file://asset/p/s/shot.png?rendition=thumbnail", width: 3840, height: 2160 }
const picture = (file: typeof large | Omit<typeof large, "thumbnailUrl">, grid?: typeof tile) => renderToStaticMarkup(
  <InlineMedia hostRef={createRef()} path="shot.png" name="shot.png" format="image" file={file} tile={grid ?? null} onRetry={() => {}} onMediaError={() => {}} />,
)
const sources = (html: string) => [...html.matchAll(/<img[^>]* src="([^"]+)"/g)].map((match) => match[1])
assert.deepEqual(sources(picture(large)), ["mako-file://asset/p/s/shot.png?rendition=thumbnail"], "alone, at one pixel to a point: the rendition that fills a 30rem box")
assert.match(picture(large), /aspect-ratio:3840 \/ 2160/, "in the picture's own shape, from its header")
assert.deepEqual(sources(picture(large, tile)), ["mako-file://asset/p/s/shot.png?rendition=thumbnail"])
const { thumbnailUrl: _none, ...small } = large
assert.deepEqual(sources(picture({ ...small, width: 800, height: 500 })), ["mako-file://asset/p/s/shot.png"])

console.log("media unavailable: ok")
