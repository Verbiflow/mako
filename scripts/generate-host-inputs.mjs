import ts from "typescript"
import { format, resolveConfig } from "prettier"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const configFile = ts.readConfigFile("tsconfig.electron.json", ts.sys.readFile)
const config = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  process.cwd()
)
const program = ts.createProgram(config.fileNames, config.options)
const checker = program.getTypeChecker()
const inputs = new Map()
/** A primitive alias keeps its name only where it's written, so a property's declared type is read too. */
const named = { NonBlankText: "z.string().trim().min(1)" }
function declaredSchema(property) {
  const type = property.valueDeclaration && ts.isPropertySignature(property.valueDeclaration) ? property.valueDeclaration.type : undefined
  const value = type && ts.isTypeReferenceNode(type) ? named[type.typeName.getText()] : undefined
  return value && (property.flags & ts.SymbolFlags.Optional ? `${value}.optional()` : value)
}
function schema(type, stack = new Set()) {
  if (type.aliasSymbol?.name === "JsonValue") return "z.json()"
  if (type.flags & ts.TypeFlags.Undefined) return "z.undefined()"
  if (type.flags & ts.TypeFlags.Null) return "z.null()"
  if (type.isStringLiteral() || type.isNumberLiteral())
    return `z.literal(${JSON.stringify(type.value)})`
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return `z.literal(${checker.typeToString(type)})`
  if (type.flags & ts.TypeFlags.String) return "z.string()"
  if (type.flags & ts.TypeFlags.Number) return "z.number()"
  if (type.flags & ts.TypeFlags.Boolean) return "z.boolean()"
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
  )
    throw new Error(`Unsupported wire input ${checker.typeToString(type)}`)
  if (stack.has(type.id))
    throw new Error(`Recursive wire input ${checker.typeToString(type)}`)
  const nested = new Set(stack).add(type.id)
  if (type.isIntersection()) {
    const members = type.types.filter(
      (member) =>
        !(member.flags & ts.TypeFlags.Object) ||
        checker.getPropertiesOfType(member).length ||
        member.getStringIndexType()
    )
    if (members.length === 1) return schema(members[0], nested)
    return members
      .map((member) => schema(member, nested))
      .reduce((left, right) => `z.intersection(${left},${right})`)
  }
  if (type.isUnion()) {
    const defined = type.types.filter(
      (item) => !(item.flags & ts.TypeFlags.Undefined)
    )
    if (defined.length !== type.types.length) {
      const value =
        defined.length === 1
          ? schema(defined[0], nested)
          : union(defined, nested)
      return `${value}.optional()`
    }
    return union(type.types, nested)
  }
  if (checker.isArrayType(type))
    return `z.array(${schema(checker.getTypeArguments(type)[0], nested)})`
  if (checker.isTupleType(type))
    return `z.tuple([${checker
      .getTypeArguments(type)
      .map((item) => schema(item, nested))
      .join(",")}])`
  const index = type.getStringIndexType()
  if (index) return `z.record(z.string(),${schema(index, nested)})`
  const properties = checker.getPropertiesOfType(type)
  if (type.getCallSignatures().length)
    throw new Error(
      `Function cannot cross host wire: ${checker.typeToString(type)}`
    )
  return `z.object({${properties
    .map((property) => {
      const value = checker.getTypeOfSymbolAtLocation(
        property,
        property.valueDeclaration ?? property.declarations[0]
      )
      try {
        return `${JSON.stringify(property.name)}:${declaredSchema(property) ?? schema(value, nested)}`
      } catch (error) {
        throw new Error(
          `${checker.typeToString(type)}.${property.name}: ${error.message}`
        )
      }
    })
    .join(",")}})`
}
function union(types, stack) {
  const choices = [...new Set(types.map((type) => schema(type, stack)))]
  if (
    choices.includes("z.literal(true)") &&
    choices.includes("z.literal(false)")
  ) {
    const rest = choices.filter(
      (value) => value !== "z.literal(true)" && value !== "z.literal(false)"
    )
    choices.splice(0, choices.length, "z.boolean()", ...rest)
  }
  return choices.length === 1 ? choices[0] : `z.union([${choices.join(",")}])`
}
for (const file of program.getSourceFiles()) {
  if (
    !file.fileName.startsWith(resolve("electron")) ||
    file.fileName.endsWith("host-call-inputs.ts")
  )
    continue
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["registerIpc", "handle"].includes(node.expression.text) &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const channel = node.arguments[0].text
      if (channel.startsWith("mako:")) {
        const signature = checker
          .getTypeAtLocation(node.arguments[1])
          .getCallSignatures()[0]
        if (!signature) throw new Error(`No handler signature for ${channel}`)
        const args = signature.parameters.slice(1).map((parameter) => {
          try {
            return schema(
              checker.getTypeOfSymbolAtLocation(
                parameter,
                parameter.valueDeclaration
              )
            )
          } catch (error) {
            throw new Error(`${channel}/${parameter.name}: ${error.message}`)
          }
        })
        if (inputs.has(channel))
          throw new Error(`Duplicate host handler ${channel}`)
        inputs.set(channel, `z.tuple([${args.join(",")}])`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}
const table = [...inputs]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([channel, input]) => `  ${JSON.stringify(channel)}: () => ${input},`)
  .join("\n")
const source = `// Generated from host handler parameter types by scripts/generate-host-inputs.mjs.
// Regenerate after changing a handler's arguments; never edit this table by hand.
import { z } from "zod"

const inputs = {
${table}
}

export type HostChannel = keyof typeof inputs
export type HostCallInput<Channel extends HostChannel> = ReturnType<(typeof inputs)[Channel]>
export type HostArguments<Channel extends HostChannel> = z.output<HostCallInput<Channel>>

export function isHostChannel(name: string): name is HostChannel {
  return Object.hasOwn(inputs, name)
}

export const hostChannels: readonly HostChannel[] = Object.keys(inputs).filter(isHostChannel)

const built = new Map<HostChannel, z.ZodType>()

/** A call's argument schema, built at the call's first use rather than when Mako starts. */
export function hostCallInput<Channel extends HostChannel>(channel: Channel): HostCallInput<Channel> {
  let schema = built.get(channel)
  if (!schema) built.set(channel, (schema = inputs[channel]()))
  // SAFETY: \`built\` only holds what inputs[channel]() returned for this same key.
  return schema as HostCallInput<Channel>
}
`
const file = "electron/contracts/host-call-inputs.ts"
const options = await resolveConfig(file)
const output = await format(source, { ...options, filepath: file })
if (process.argv.includes("--check")) {
  if ((await readFile(file, "utf8")) !== output)
    throw new Error(
      "Host input schemas are stale. Run npm run generate:host-inputs."
    )
} else await writeFile(file, output)
console.log(
  `${inputs.size} host method argument schemas ${process.argv.includes("--check") ? "verified" : "generated"}`
)
