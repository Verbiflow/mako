import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"

const choice = z.object({
  id: z.string().min(1).max(100),
  product: z.string().max(80).optional(),
  profileName: z.string().max(100).optional(),
  name: z.string().min(1).max(100),
  transport: z.enum(["extension", "direct"]).optional(),
})
export type BrowserPreference = z.infer<typeof choice>

/** One host owns this profile file. Failed writes never publish a new choice. */
export class BrowserPreferences {
  value: BrowserPreference | null = null
  private loaded?: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private readonly path?: string
  constructor(path?: string) {
    this.path = path
  }
  load(): Promise<void> {
    return (this.loaded ??= this.read())
  }
  private async read(): Promise<void> {
    if (!this.path) return
    try {
      if ((await stat(this.path)).size > 4096)
        throw new Error("Browser preference file is too large")
      this.value = choice
        .nullable()
        .parse(JSON.parse(await readFile(this.path, "utf8")))
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error
    }
  }
  set(value: BrowserPreference | null): Promise<void> {
    const next = this.writes.then(async () => {
      await this.load()
      const validated = choice.nullable().parse(value)
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true })
        const temporary = `${this.path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(validated), {
            mode: 0o600,
            flag: "wx",
          })
          await rename(temporary, this.path)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      this.value = validated
    })
    this.writes = next.catch(() => {})
    return next
  }
}
