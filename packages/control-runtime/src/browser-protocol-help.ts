import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { z } from "zod"
const domainSchema = z.object({
  domain: z.string(),
  description: z.string().optional(),
  commands: z.array(z.record(z.string(), z.json())).optional(),
  events: z.array(z.record(z.string(), z.json())).optional(),
  types: z.array(z.record(z.string(), z.json())).optional(),
})
const protocolSchema = z.object({ domains: z.array(domainSchema) })
const require = createRequire(import.meta.url)

/** The Chrome DevTools Protocol reference, read from `devtools-protocol` the first time it is asked and again after a failed read. */
export class ProtocolReference {
  private domains: Promise<z.infer<typeof domainSchema>[]> | undefined

  async help(domain?: string, method?: string) {
    const domains = await (this.domains ??= this.read())
    if (!domain)
      return domains.map((entry) => ({
        domain: entry.domain,
        description: entry.description ?? "",
      }))
    const entry = domains.find((entry) => entry.domain === domain)
    if (!entry)
      throw new Error(
        "Unknown protocol domain. Call help without a domain to list them."
      )
    if (!method)
      return {
        domain,
        commands: entry.commands?.map((command) => ({
          name: command.name,
          description: command.description,
        })),
        events: entry.events?.map((event) => event.name),
      }
    const command = entry.commands?.find((command) => command.name === method)
    if (!command) throw new Error("Unknown command in this protocol domain.")
    return { domain, command, types: entry.types ?? [] }
  }

  private read(): Promise<z.infer<typeof domainSchema>[]> {
    const reading = Promise.all(
      ["browser_protocol", "js_protocol"].map(
        async (name) =>
          protocolSchema.parse(
            JSON.parse(
              await readFile(
                require.resolve(`devtools-protocol/json/${name}.json`),
                "utf8"
              )
            )
          ).domains
      )
    ).then((lists) => lists.flat())
    void reading.catch(() => {
      if (this.domains === reading) this.domains = undefined
    })
    return reading
  }
}
