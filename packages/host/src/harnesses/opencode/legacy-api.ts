import { z } from "zod"

/**
 * OpenCode's API as the releases from 2.0.0 to 2.0.3 serve it: the same
 * sessions, with some requests under the names 2.0.4 replaced. Mako's client
 * speaks the current API; this rewrites the requests Mako sends whose shape
 * changed, and the one answer that moved, so nothing past the transport knows
 * which API it talks to. Prereleases from those weeks changed the routes one
 * build at a time, so `version.ts` runs only the builds after the last change.
 */

const Reply = z.object({ decision: z.enum(["once", "always", "reject"]), message: z.string().optional() }).strict()
const Command = z.looseObject({ name: z.string() })
const Fork = z.object({ before: z.string().nullish() }).strict()
const Page = z.object({ data: z.array(z.object({ id: z.string() })) })
const Data = z.object({ data: z.record(z.string(), z.unknown()) })
/** A request body that must be JSON, parsed and then checked against `schema`. */
const jsonBody = <Schema extends z.ZodType>(schema: Schema) =>
  z
    .string()
    .transform((text, context) => {
      try {
        return JSON.parse(text)
      } catch {
        context.addIssue({ code: "custom", message: "not JSON" })
        return z.NEVER
      }
    })
    .pipe(schema)

const PERMISSION_REPLY = /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/
const COMMAND = /^\/api\/session\/[^/]+\/command$/
const FORK = /^(\/api\/session\/[^/]+)\/fork$/
const FORM = /^\/api\/session\/[^/]+\/form\/[^/]+$/
const MCP_SERVER = /^\/api\/experimental(\/mcp\/[^/]+)$/

/** A fetch that speaks the API before 2.0.4 to the server behind `fetch`, for requests made in the current one. */
export function openCodeLegacyFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init.method ?? "GET"
    const path = url.pathname
    const send = (to: string, change: RequestInit) => fetch(new URL(to + url.search, url), { ...init, ...change })
    const read = (to: string) => fetch(new URL(to, url), { method: "GET", headers: init.headers, signal: init.signal })

    if (method === "POST" && PERMISSION_REPLY.test(path)) {
      const { decision, message } = jsonBody(Reply).parse(init.body)
      return send(path, { body: JSON.stringify({ reply: decision, message }) })
    }
    if (method === "POST" && COMMAND.test(path)) {
      const { name, ...rest } = jsonBody(Command).parse(init.body)
      return send(path, { body: JSON.stringify({ command: name, ...rest }) })
    }
    const fork = method === "POST" ? FORK.exec(path) : null
    if (fork) {
      // Forking without a boundary copies the whole session: through its newest message.
      const { before } = jsonBody(Fork).parse(init.body)
      if (before) return send(path, { body: JSON.stringify({ boundary: { type: "before", messageID: before } }) })
      const newest = await read(`${fork[1]}/message?order=desc&limit=1`)
      if (!newest.ok) return newest
      const [last] = Page.parse(await newest.json()).data
      if (!last) throw new Error("OpenCode's session has no message to fork through")
      return send(path, { body: JSON.stringify({ boundary: { type: "through", messageID: last.id } }) })
    }
    if (method === "DELETE" && FORM.test(path)) return send(`${path}/cancel`, { method: "POST" })
    if (method === "GET" && FORM.test(path)) {
      // The form's state had its own route before `form.get` answered with it.
      const [form, state] = await Promise.all([fetch(input, init), read(`${path}/state`)])
      if (!form.ok || !state.ok) {
        await Promise.all([form, state].filter(response => response.ok).map(response => response.body?.cancel()))
        return form.ok ? state : form
      }
      const [detail, current] = await Promise.all([form.json(), state.json()])
      return Response.json({ data: { ...Data.parse(detail).data, state: Data.parse(current).data } })
    }
    const mcp = MCP_SERVER.exec(path)
    if (mcp) return send(`/api${mcp[1]}`, {})
    return fetch(input, init)
  }
}
