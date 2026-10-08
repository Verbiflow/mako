/**
 * Module hooks for `devin-app-journal.mjs`: `electron` is a stand-in (the
 * store never uses it), and the shared process's source, as loaded, also
 * exports its message store. Fails when the bundle's end has moved, rather
 * than running a store it can't name.
 */

let store

export function initialize(data) {
  store = `file://${data.store}`
}

export async function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: "data:text/javascript,export const net = {}; export default {};", shortCircuit: true }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url !== store) return next(url, context)
  const loaded = await next(url, { ...context, format: "module" })
  const source = String(loaded.source)
  const end = "export{Kk as main};"
  if (!source.includes(end) || !source.includes("var gn=class{constructor(n,e){this._logService=n;this._rowCacheCapacity=gn.ROW_CACHE_CAPACITY"))
    throw new Error("Devin.app's shared process no longer has the message store this script was written against (3.10.23)")
  return { format: "module", source: source.replace(end, "export{Kk as main,gn as AcpMessageStore};"), shortCircuit: true }
}
