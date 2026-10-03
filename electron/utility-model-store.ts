import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type {
  UtilityConnection,
  UtilityConnectionInput,
  UtilityCredentialInput,
  UtilityModelSettings,
  UtilityProvider,
} from "./shared.js"
import {
  completeUtilityText,
  connectionSchema,
  parseConnection,
  parseUtilityEndpoint,
  utilityLanguageModel,
  utilityProviders,
  utilityProviderSchema,
  UtilityModelError,
} from "./utility-models.js"

export interface UtilityKeyEncryption {
  available(): boolean | Promise<boolean>
  encrypt(value: string): Buffer | Promise<Buffer>
  decrypt(value: Buffer): string | Promise<string>
}

const apiKeySchema = z
  .string()
  .trim()
  .max(16_384)
  .regex(/^[\x20-\x7e]*$/)
const storedSchema = connectionSchema.extend({ apiKey: apiKeySchema })
const titleChoiceSchema = z.object({ model: z.string().min(1).max(400) })
const credentialSchema = z.object({
  provider: utilityProviderSchema,
  baseUrl: z.string().max(2_048).optional(),
  apiKey: apiKeySchema.optional(),
})

export interface UtilityModelStoreOptions {
  /**
   * Work the directory needs before it is read, such as moving a profile's
   * files into the shared store. Every read and write waits for it; a failure
   * surfaces on the first call rather than being swallowed at construction.
   */
  ready?: Promise<unknown>
}

export class UtilityModelStore {
  private readonly writing = new Set<UtilityProvider>()

  private readonly directory: string
  private readonly encryption: UtilityKeyEncryption
  private readonly ready: Promise<unknown>

  constructor(
    directory: string,
    encryption: UtilityKeyEncryption,
    options: UtilityModelStoreOptions = {}
  ) {
    this.directory = directory
    this.encryption = encryption
    this.ready = options.ready ?? Promise.resolve()
  }

  async settings(): Promise<UtilityModelSettings> {
    await this.ready
    const connections: UtilityConnection[] = []
    const issues: UtilityModelSettings["issues"] = []
    for (const { id } of utilityProviders) {
      try {
        const stored = await this.load(id)
        if (stored) {
          connections.push(parseConnection(stored))
        }
      } catch {
        issues.push({
          provider: id,
          message:
            "Saved connection unavailable. Unlock your keychain or reconnect with an API key.",
        })
      }
    }
    const settings: UtilityModelSettings = {
      providers: utilityProviders,
      connections,
      issues,
      secureStorage: await this.encryption.available(),
    }
    const titleModel = await this.titleModel()
    if (titleModel) settings.titleModel = titleModel
    return settings
  }

  /**
   * The model chosen to name Threads, as `provider/model`, or null while
   * automatic titles are off. It is a choice, not a key, so it is stored in
   * the clear beside the connections and every host reads the same one.
   */
  async titleModel(): Promise<string | null> {
    await this.ready
    try {
      const info = await stat(this.titleModelPath())
      if (info.size > 4_096) return null
      return titleChoiceSchema.parse(JSON.parse(await readFile(this.titleModelPath(), "utf8"))).model
    } catch {
      return null
    }
  }

  /** Choose the connected model that names Threads, or null to turn automatic titles off. */
  async setTitleModel(model: string | null): Promise<void> {
    await this.ready
    if (model === null) {
      await rm(this.titleModelPath(), { force: true })
      return
    }
    const provider = utilityProviders.find(({ id }) => model.startsWith(`${id}/`))
    const connection = provider ? await this.load(provider.id) : null
    if (!connection || `${connection.provider}/${connection.model}` !== model)
      throw new Error("Connect this model in Settings > Commit messages before choosing it for Thread titles.")
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.titleModelPath()}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ model }), { mode: 0o600, flag: "wx" })
      await rename(temporary, this.titleModelPath())
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async load(provider: UtilityProvider) {
    await this.ready
    const path = this.path(provider)
    try {
      const info = await stat(path)
      if (info.size > 32_768) throw new Error("Invalid credential file")
      if (!(await this.encryption.available()))
        throw new Error("Secure storage unavailable")
      const value = storedSchema.parse(
        JSON.parse(await this.encryption.decrypt(await readFile(path)))
      )
      return { ...parseConnection(value), apiKey: value.apiKey }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null
      throw new UtilityModelError(
        "auth",
        "The saved model connection could not be opened. Unlock your system keychain or reconnect the provider in Commit messages settings."
      )
    }
  }

  async credentials(input: UtilityCredentialInput) {
    const parsed = credentialSchema.safeParse(input)
    if (!parsed.success)
      throw new Error("Enter a valid provider, endpoint, and API key.")
    const value = parsed.data
    const baseUrl = parseUtilityEndpoint(value)
    const previous = value.apiKey ? null : await this.load(value.provider)
    const apiKey = value.apiKey || previous?.apiKey || ""
    if (!apiKey && value.provider !== "openai-compatible")
      throw new Error("Enter an API key to fetch models from this provider.")
    if (previous?.baseUrl !== baseUrl && !value.apiKey && previous?.apiKey)
      throw new Error(
        "Re-enter the API key when changing endpoints. Saved keys are never sent to a new endpoint automatically."
      )
    return { provider: value.provider, baseUrl, apiKey }
  }

  async connect(input: UtilityConnectionInput): Promise<UtilityConnection> {
    await this.ready
    const connection = parseConnection(input)
    if (!(await this.encryption.available()))
      throw new Error(
        "Secure key storage is unavailable. Unlock your system keychain before connecting a model."
      )
    this.lock(connection.provider)
    try {
      const { apiKey } = await this.credentials(input)
      await completeUtilityText(
        utilityLanguageModel(connection, apiKey),
        "Reply with OK only.",
        "Test the model connection.",
        AbortSignal.timeout(25_000),
        1_024
      )
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = this.path(connection.provider)
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(
          temporary,
          await this.encryption.encrypt(JSON.stringify({ ...connection, apiKey })),
          { mode: 0o600, flag: "wx" }
        )
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      return connection
    } finally {
      this.writing.delete(connection.provider)
    }
  }

  async disconnect(provider: UtilityProvider): Promise<void> {
    await this.ready
    this.lock(provider)
    try {
      await rm(this.path(provider), { force: true })
      // Titles stop with the connection rather than moving to another provider.
      if ((await this.titleModel())?.startsWith(`${provider}/`)) await rm(this.titleModelPath(), { force: true })
    } finally {
      this.writing.delete(provider)
    }
  }

  private path(provider: UtilityProvider) {
    return join(this.directory, `${utilityProviderSchema.parse(provider)}.enc`)
  }

  private titleModelPath() {
    return join(this.directory, "thread-titles.json")
  }

  private lock(provider: UtilityProvider) {
    if (this.writing.has(provider))
      throw new Error(
        "This connection is already being updated. Wait for it to finish and retry."
      )
    this.writing.add(provider)
  }
}
