import { z } from "zod"
import { ThreadIdSchema } from "./ids.js"

/**
 * An account's Threads as every client lists them: what a row needs, and nothing that takes waking a machine to
 * read. Each Thread's object keeps its listing from what its runtime says of its conversations (the runtime's
 * `listing` frame, link version 4 on), adds what only the cloud knows (where it runs, its repository), and the
 * account's object keeps them all: `GET /v1/threads` lists them, and the account's stream says each change
 * (`thread-listed`, `thread-unlisted`), so a Thread one device starts shows on every other at once.
 */

/**
 * Where a conversation stands, as a list shows it. `working`: a turn, queued work or work it left running in the
 * background. `waiting`: on a person, an approval or a question. `idle`: ready for the next message. `failed`: its last
 * turn failed. `closed`: it was closed and takes no more.
 */
export const ListedStateSchema = z.enum(["working", "waiting", "idle", "failed", "closed"])
export type ListedState = z.infer<typeof ListedStateSchema>

/** One of a Thread's conversations, as its runtime last said. */
export const ListedConversationSchema = z
  .object({
    /** The conversation's ID on the runtime that runs it, which every call to it names. */
    id: z.string().min(1).max(128),
    harness: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    title: z.string().max(200).optional(),
    state: ListedStateSchema,
    /** The folder it works in, where it runs: a Thread moved from a device keeps the device's own path. */
    folder: z.string().max(1024).optional(),
    /** The Thread and Session of the runtime's store it's filed under: a Thread moved from a device keeps the device's. */
    thread: z.uuid().optional(),
    session: z.uuid().optional(),
    createdAt: z.iso.datetime(),
  })
  .strict()
export type ListedConversation = z.infer<typeof ListedConversationSchema>

/** A Thread lists at most this many conversations, its newest. */
export const LISTED_CONVERSATIONS = 50

/** What a runtime says of a Thread it runs: its conversations, newest first. Only the Thread's owner is heard. */
export const RuntimeListingSchema = z
  .object({ conversations: z.array(ListedConversationSchema).max(LISTED_CONVERSATIONS) })
  .strict()
export type RuntimeListing = z.infer<typeof RuntimeListingSchema>

/** The GitHub repository a cloud Thread works in, as its object holds it. */
export const ListedRepositorySchema = z.object({ url: z.string().max(200), branch: z.string().max(200).optional() }).strict()

/** One of an account's Threads, as every client lists it. */
export const ThreadListingSchema = z
  .object({
    threadId: ThreadIdSchema,
    /** `cloud`: a machine runs it. `device`: one of the account's devices does (`deviceId`). */
    home: z.enum(["cloud", "device"]),
    deviceId: z.uuid().optional(),
    repository: ListedRepositorySchema.optional(),
    conversations: z.array(ListedConversationSchema).max(LISTED_CONVERSATIONS),
    /** When anything listed here last changed. */
    updatedAt: z.iso.datetime(),
  })
  .strict()
export type ThreadListing = z.infer<typeof ThreadListingSchema>

/**
 * Why a Thread left the list: it `returned` to the device it came from (whose own Thread goes on there), or it
 * `ended` (removed, or its runtime holds no conversation any more).
 */
export const UnlistedReasonSchema = z.enum(["returned", "ended"])
export type UnlistedReason = z.infer<typeof UnlistedReasonSchema>

/**
 * `GET /v1/threads`: every listed Thread of the account, and the account stream's number as they were read. A client
 * lists, then follows the stream after `seq`, and misses nothing between.
 */
export const ThreadListingsSchema = z
  .object({ threads: z.array(ThreadListingSchema), seq: z.number().int().nonnegative() })
  .strict()
export type ThreadListings = z.infer<typeof ThreadListingsSchema>

/**
 * Whether two listings would show the same, so a Thread's object tells its account only of a change a list shows.
 * `updatedAt` is when, not what, and isn't compared.
 */
export function sameListing(left: Omit<ThreadListing, "updatedAt"> | undefined, right: Omit<ThreadListing, "updatedAt"> | undefined): boolean {
  if (!left || !right) return left === right
  return (
    left.threadId === right.threadId &&
    left.home === right.home &&
    left.deviceId === right.deviceId &&
    left.repository?.url === right.repository?.url &&
    left.repository?.branch === right.repository?.branch &&
    left.conversations.length === right.conversations.length &&
    left.conversations.every((conversation, index) => sameConversation(conversation, right.conversations[index]))
  )
}

function sameConversation(left: ListedConversation, right: ListedConversation | undefined): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.harness === right.harness &&
    left.title === right.title &&
    left.state === right.state &&
    left.folder === right.folder &&
    left.thread === right.thread &&
    left.session === right.session &&
    left.createdAt === right.createdAt
  )
}
