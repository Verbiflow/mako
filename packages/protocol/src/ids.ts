import { z } from "zod"

const NAME = /^[A-Za-z0-9._:-]{1,160}$/

/** Carried from the first client through every hop, so one request's logs can be found together. */
export const CorrelationIdSchema = z.string().regex(/^[\w=-]{1,128}$/)
/** Minted by the caller; a repeat of the same id is the same operation, answered once. */
export const OperationIdSchema = z.uuid()
export const ThreadIdSchema = z.string().regex(NAME)
export const RuntimeIdSchema = z.string().regex(NAME)
export const DeviceIdSchema = z.string().regex(NAME)
/** Raised each time a Thread changes hands; whoever holds an older one is fenced. */
export const GenerationSchema = z.number().int().nonnegative()
/** An event's position in its stream, from 1, with no gaps. */
export const SeqSchema = z.number().int().positive()
/** Whatever a peer sent, decoded from the wire but not yet checked against a schema. */
export const JsonSchema = z.json()

export type CorrelationId = z.infer<typeof CorrelationIdSchema>
export type OperationId = z.infer<typeof OperationIdSchema>
export type ThreadId = z.infer<typeof ThreadIdSchema>
export type RuntimeId = z.infer<typeof RuntimeIdSchema>
export type DeviceId = z.infer<typeof DeviceIdSchema>
export type Generation = z.infer<typeof GenerationSchema>
export type Seq = z.infer<typeof SeqSchema>
export type Json = z.infer<typeof JsonSchema>
