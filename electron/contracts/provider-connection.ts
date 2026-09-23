import { z } from "zod"

/**
 * A provider transport that keeps its own sign-in, separate from the CLI the
 * user may already be logged into. The renderer shows the state and offers
 * the actions; the host answers with public account facts and never a
 * credential. Cursor's SDK is the first: every Cursor thread runs through it,
 * under a key the host resolves from its environment, its own encrypted
 * store, the SDK's file, or the CLI's keychain login.
 */
export const ProviderConnectionSourceSchema = z.enum([
  "env",
  "mako",
  "sdk",
  "cli",
])
export type ProviderConnectionSource = z.infer<
  typeof ProviderConnectionSourceSchema
>

export const ProviderConnectionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable"), message: z.string() }),
  z.object({
    status: z.literal("signed-out"),
    /** A key exists but does not work; the row says why instead of "not signed in". */
    problem: z
      .object({ source: ProviderConnectionSourceSchema, message: z.string() })
      .optional(),
  }),
  z.object({
    status: z.literal("signed-in"),
    /** Where the working key came from, so the row can say "via cursor-agent". */
    source: ProviderConnectionSourceSchema,
    /** How a Mako-held key was obtained. */
    method: z.enum(["browser", "pasted"]).optional(),
    /** Public account label, when the provider reports one. */
    account: z.string().optional(),
    /** The key's name in the provider's dashboard, when known. */
    keyName: z.string().optional(),
    /** When the credential lapses, so Settings can say "expires in 3 months". */
    expiresAt: z.string().optional(),
  }),
])
export type ProviderConnectionState = z.infer<
  typeof ProviderConnectionStateSchema
>

export const ProviderConnectionSchema = z.object({
  provider: z.string(),
  /** What the connection is for, in the provider's own words: "Cursor". */
  label: z.string(),
  /** One sentence on what signing in changes. */
  description: z.string(),
  state: ProviderConnectionStateSchema,
  /** Whether keys can be saved: false when the OS keychain is unavailable to this host. */
  secureStorage: z.boolean(),
  /** Actions implemented by the provider. Omitted by older hosts with the original key/browser flow. */
  actions: z
    .array(z.enum(["sign-in-browser", "sign-in-key", "sign-out"]))
    .optional(),
  /** Where a pasted key is made, for the row's link. */
  keyUrl: z.string().optional(),
  /** When the host last asked the provider. */
  checkedAt: z.string().optional(),
})
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>

export const ProviderConnectionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refresh") }),
  /** The provider's browser sign-in; the host opens the page and waits. */
  z.object({ kind: z.literal("sign-in-browser") }),
  /** A key pasted from the provider's dashboard; verified before it is saved. */
  z.object({
    kind: z.literal("sign-in-key"),
    apiKey: z.string().min(1).max(4_096),
  }),
  z.object({ kind: z.literal("sign-out") }),
])
export type ProviderConnectionAction = z.infer<
  typeof ProviderConnectionActionSchema
>
