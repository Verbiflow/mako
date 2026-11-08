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

console.log("media unavailable: ok")
