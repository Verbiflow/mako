import { PAGE_FIT_SCRIPT } from "../contracts/page-frame.js"

/**
 * What a served file may do once a renderer loads it, by its type, as the
 * `/file/` route answers it. Every response is `nosniff`, so a file is only
 * ever what its sniffed type says.
 *
 * - Pictures, video, audio and fonts carry no policy: they run no code.
 * - SVG can carry script and links, so it draws as a picture only: nothing
 *   loads, nothing runs, inline styles apply.
 * - A page runs sandboxed in an opaque origin: its scripts, forms and
 *   popups work, and it reaches no cookie, storage or Mako call.
 * - Anything else (text, JSON, a stylesheet a page links) is inert where it
 *   is opened directly.
 *
 * The route applies it to every answer, so no producer of a file response
 * can forget it.
 */
export function filePolicyHeaders(mimeType: string | undefined): FilePolicyHeaders {
  const type = mimeType?.split(";")[0]?.trim().toLowerCase() ?? ""
  const policy = type === "image/svg+xml" ? SVG_POLICY
    : type === "text/html" ? PAGE_POLICY
      : /^(?:image|video|audio|font)\//.test(type) ? undefined
        : INERT_POLICY
  return { "x-content-type-options": "nosniff", ...(policy && { "content-security-policy": policy }) }
}

/** The headers a served file carries for its type; media has no policy at all. */
export interface FilePolicyHeaders {
  "x-content-type-options": "nosniff"
  "content-security-policy"?: typeof SVG_POLICY | typeof PAGE_POLICY | typeof INERT_POLICY
}

export const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
export const PAGE_POLICY = "sandbox allow-scripts allow-forms allow-popups"
export const INERT_POLICY = "sandbox; default-src 'none'"


/**
 * The page with its height reporter as the first thing it runs. Spliced in
 * by byte offset, never decoded, so a page in any ASCII-compatible encoding
 * keeps its bytes and its own charset declaration.
 */
export function fitPage(page: Buffer): Buffer {
  const text = page.toString("latin1")
  const head = /<head(?:\s[^>]*)?>/i.exec(text)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text)
  const at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0
  return Buffer.concat([page.subarray(0, at), Buffer.from(PAGE_FIT_SCRIPT), page.subarray(at)])
}
