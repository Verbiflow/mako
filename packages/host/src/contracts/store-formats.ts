import { z } from "zod"

/**
 * The stores every Mako on this Mac shares under `~/.mako`, and where each
 * stands for this build (`@mako/sessions/store-format`). A store keeps the
 * format a build needs to write it and the oldest that can read it; a build
 * between the two reads it and changes nothing a newer Mako's layout holds,
 * and only one older than both leaves it. Settings › Diagnostics and the
 * rail say so in one line each, with Update.
 */
export const SharedStoreSchema = z.enum(["threads", "session-memory", "records", "unread", "outputs", "archive"])
export type SharedStore = z.infer<typeof SharedStoreSchema>

export const StoreStandingRowSchema = z.object({
  store: SharedStoreSchema,
  /** `write`: this build reads and writes it; `read`: a newer Mako changed it and this build only reads it; `refused`: this build can't read it. */
  access: z.enum(["write", "read", "refused"]),
  /** This build's format of the store. */
  build: z.number().int(),
  /** The store's own numbers, when it keeps them. */
  writableBy: z.number().int().optional(),
  readableBy: z.number().int().optional(),
  /** The Mako that raised the store's format, as it stamped itself: "0.163.0", or "0.0.1+development" for a checkout. */
  writtenBy: z.string().optional(),
  /** The oldest Mako that reads the store, stamped the same way. */
  readableFrom: z.string().optional(),
})
export type StoreStandingRow = z.infer<typeof StoreStandingRowSchema>

export const StoreFormatsSchema = z.object({ stores: z.array(StoreStandingRowSchema) })
export type StoreFormats = z.infer<typeof StoreFormatsSchema>
