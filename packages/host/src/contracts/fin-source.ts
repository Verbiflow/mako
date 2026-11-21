import { z } from "zod"
import { CloudRepositorySchema } from "./cloud-threads.js"

/** Committed input for a Fin, independent of the branch it will write on. No local paths or credentials cross. */
export const CommittedFinSourceSchema = z.lazy(() => z.object({
  version: z.literal(1),
  repository: CloudRepositorySchema,
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  cwd: z.string().min(1).max(1024).refine(value => value === "." || value.split("/").every(part => part.length > 0 && part !== "." && part !== "..") && !/[\\\0]/.test(value)),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict())
export type CommittedFinSource = z.infer<typeof CommittedFinSourceSchema>
