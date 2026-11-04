import { z } from "zod"

/**
 * Cloud access grants: a person's scoped API token for one outside service (Cloudflare, Vercel), kept by their account
 * for one project (a GitHub repository), sealed, and given only to that project's cloud Threads of that person. Each
 * new shell on the machine has the service's variables; removing the grant reaches running machines within a minute
 * and every new shell after that. Every hand-over to a machine is recorded (Thread, machine, time) and shown in
 * Settings. Agents and devices never read a value back: a device sends the token once, to be checked and kept, and
 * keeps none of it.
 *
 * The account's routes, each about one repository (`?repository=`, the project's `https://github.com/<owner>/<name>`):
 * `GET /v1/accounts/:account/cloud-access` lists its grants, `PUT …/cloud-access/:service` checks a token with the
 * service and keeps it, `DELETE …/cloud-access/:service` removes it, and `GET …/cloud-access/uses` lists the latest
 * hand-overs. A refusal is a problem document whose title says why in plain words.
 */

export const CLOUD_ACCESS_SERVICES = ["cloudflare", "vercel"] as const
export const CloudAccessServiceSchema = z.enum(CLOUD_ACCESS_SERVICES)
export type CloudAccessService = z.infer<typeof CloudAccessServiceSchema>

/** A project as the account knows it: its GitHub repository's URL. */
export const CloudAccessRepositorySchema = z.string().max(200).regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)

/** One service's grant for one project, as any device sees it: never the token, only what it acts in and when it was last given to a cloud Thread. */
export const CloudAccessGrantSchema = z.object({
  service: CloudAccessServiceSchema,
  repository: z.string(),
  /** The Cloudflare account, or the Vercel team (or user), the token acts in; `name` when the service gave one. */
  account: z.object({ id: z.string().min(1).max(200), name: z.string().max(200).nullable() }),
  /** The names each shell gets, never their values. */
  variables: z.array(z.string().min(1).max(100)).max(20),
  savedAt: z.string(),
  /** When the service says the token lapses; null for one without an expiry. */
  expiresAt: z.string().nullable(),
  /** The last time a cloud Thread's machine was given it. */
  lastGiven: z.object({ at: z.string(), threadId: z.string() }).nullable(),
})
export type CloudAccessGrant = z.infer<typeof CloudAccessGrantSchema>

export const CloudAccessGrantsAnswerSchema = z.object({ grants: z.array(CloudAccessGrantSchema) })

/** One hand-over of a grant to a cloud Thread's machine. */
export const CloudAccessUseSchema = z.object({
  service: CloudAccessServiceSchema,
  threadId: z.string(),
  machine: z.string().nullable(),
  at: z.string(),
})
export type CloudAccessUse = z.infer<typeof CloudAccessUseSchema>

/** Newest first, at most `CLOUD_ACCESS_USES_LISTED`. */
export const CloudAccessUsesAnswerSchema = z.object({ uses: z.array(CloudAccessUseSchema) })
export const CLOUD_ACCESS_USES_LISTED = 20

export type CloudAccessServiceInfo = {
  name: string
  /** One line on what it gives a cloud Thread. */
  gives: string
  /** The service's own page for a new token. */
  tokenPage: string
  /** What to choose on that page. */
  choose: string
  /** The variables each shell gets; `whenAccount` only once an account is named or found. */
  variables: { always: readonly string[]; whenAccount: readonly string[] }
  /** The optional field beside the token, and when it's needed. */
  account: { label: string; placeholder: string; hint: string }
  /** The shortest a pasted token can be: anything shorter is a slip, not a token. */
  minLength: number
}

/** Each service as Settings shows it, in the order it lists them. */
export const CLOUD_ACCESS_CATALOG = {
  cloudflare: {
    name: "Cloudflare",
    gives: "Wrangler and the Cloudflare API",
    tokenPage: "https://dash.cloudflare.com/profile/api-tokens",
    choose: "Create a token from the “Edit Cloudflare Workers” template, or a narrower one, for the account this project deploys to.",
    variables: { always: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], whenAccount: [] },
    account: { label: "Account ID", placeholder: "Account ID (optional)", hint: "Needed only when the token reaches more than one account." },
    minLength: 20,
  },
  vercel: {
    name: "Vercel",
    gives: "The Vercel CLI and API",
    tokenPage: "https://vercel.com/account/settings/tokens",
    choose: "Create a token scoped to the one team this project deploys with, and give it an expiry.",
    variables: { always: ["VERCEL_TOKEN"], whenAccount: ["VERCEL_ORG_ID"] },
    account: { label: "Team", placeholder: "Team ID or slug (optional)", hint: "Name the team when the token can reach more than one." },
    minLength: 20,
  },
} satisfies Record<CloudAccessService, CloudAccessServiceInfo>

/** Settings' words for the part, the same on the desktop, in a browser and on a phone. */
export const CLOUD_ACCESS_HINT = "Accounts this project's cloud Threads can use. Each shell gets the variables; nothing else does."
