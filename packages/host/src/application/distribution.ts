import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

const distributionSchema = z.enum(["signed", "unsigned", "local"])
const metadataSchema = z.object({ makoDistribution: distributionSchema })
export type Distribution = z.infer<typeof distributionSchema>

export function distributionFromMetadata(contents: string): Distribution {
  try {
    return metadataSchema.safeParse(JSON.parse(contents)).data?.makoDistribution ?? "unsigned"
  } catch {
    return "unsigned"
  }
}

export function packagedDistribution(appPath: string): Distribution {
  try {
    return distributionFromMetadata(
      readFileSync(join(appPath, "package.json"), "utf8")
    )
  } catch {
    return "unsigned"
  }
}
