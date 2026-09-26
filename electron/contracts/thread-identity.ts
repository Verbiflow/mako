import { z } from "zod"

/**
 * Identities of the Thread model (primitive P1). A Thread groups Sessions; a
 * Session is one logical conversation, which may own several journals and
 * native sessions over its life. Each ID is a random UUID minted by the
 * per-user Thread store, never derived from a directory, path, title, native
 * ID or conversation ID, so it survives reopen, restart, rename and handoff.
 * The brands keep a journal's conversation ID from being passed as either.
 */
export const ThreadIdSchema = z.string().uuid().brand<"ThreadId">()
export type ThreadId = z.infer<typeof ThreadIdSchema>
export const SessionIdSchema = z.string().uuid().brand<"SessionId">()
export type SessionId = z.infer<typeof SessionIdSchema>
export const PrincipalIdSchema = z.string().uuid().brand<"PrincipalId">()
export type PrincipalId = z.infer<typeof PrincipalIdSchema>

export const SERVICE_ACTORS = [
  "migration",
  "catalog",
  "auto-continue",
  "relay",
] as const

/**
 * Who initiated an operation (primitive P8). The executing harness is already
 * named by the binding; this is the initiator: a person, a harness Session
 * acting through Mako's tools, or Mako itself. The host assigns it; it is
 * never read from a caller's input.
 */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), principal: PrincipalIdSchema }),
  z.object({ kind: z.literal("agent"), session: SessionIdSchema }),
  z.object({ kind: z.literal("service"), name: z.enum(SERVICE_ACTORS) }),
])
export type Actor = z.infer<typeof ActorSchema>

/** Where a journal or native session belongs. */
export interface ThreadPlacement {
  thread: ThreadId
  session: SessionId
}
