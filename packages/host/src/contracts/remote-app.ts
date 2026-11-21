import { z } from "zod"

/** Bounded passive demand, owned by a page's view, separate from its browser sign-in and other tabs. */
export const REMOTE_APP_LEASE_MS = 90_000
export const REMOTE_APP_RENEW_MS = 30_000
export const RemoteAppDemandSchema = z.lazy(() => z.object({
  view: z.string().uuid(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  visible: z.boolean(),
  confirm: z.boolean(),
}).strict())
/** @wire z.object({ view: z.string().uuid(), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), visible: z.boolean(), confirm: z.boolean() }).strict() */
export type RemoteAppDemand = z.infer<typeof RemoteAppDemandSchema>
export const AppHintPositionSchema = z.object({ epoch: z.string().uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
export const RemoteAppReplySchema = z.lazy(() => z.discriminatedUnion("kind", [
  AppHintPositionSchema.extend({ kind: z.literal("following") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]))
export type RemoteAppReply = z.infer<typeof RemoteAppReplySchema>
/** No paths, app content or other conversations' identities cross the gateway with a hint. */
export const RemoteAppHintSchema = AppHintPositionSchema.extend({
  type: z.literal("conversation-app-hint"),
  conversationId: z.string().min(1).max(128),
  fields: z.array(z.string().max(80)).max(32),
  ready: z.literal(true).optional(),
}).strict()
export type RemoteAppHint = z.infer<typeof RemoteAppHintSchema>

export interface RemoteAppSnapshot { folder: string; app: import("./thread-app.js").ThreadAppView }
