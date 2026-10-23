import ts from "typescript"
import { format, resolveConfig } from "prettier"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

/**
 * Handlers and the client call list live in electron/ and in @mako/host's
 * sources, so one program reads both, the package from source rather than
 * through its built declarations.
 */
const parse = (path) =>
  ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")) } })
const electron = parse("tsconfig.electron.json")
const host = parse("packages/host/tsconfig.json")
const hostSource = resolve("packages/host/src")
const program = ts.createProgram([...electron.fileNames, ...host.fileNames], {
  ...electron.options,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  paths: { "@mako/host/*": [`${hostSource}/*`] },
  rootDir: undefined,
  outDir: undefined,
  noEmit: true,
})
const checker = program.getTypeChecker()
const inputs = new Map()
/** The domain each host method is declared in: the folder of packages/host/src holding its handler. */
const owners = new Map()
/**
 * A type alias whose comment has a `@wire` tag crosses the wire as that
 * schema, which holds what TypeScript can't say (a length, a count, no
 * blanks). A primitive alias keeps its name only where it's written, so the
 * declared type of a property or a handler's parameter is read for it.
 */
function wireOf(node) {
  if (!node || !ts.isTypeReferenceNode(node)) return undefined
  let symbol = checker.getSymbolAtLocation(node.typeName)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  for (const declaration of symbol?.declarations ?? [])
    for (const tag of ts.getJSDocTags(declaration))
      if (tag.tagName.text === "wire") {
        const value = ts.getTextOfJSDocComment(tag.comment)?.trim()
        if (!value) throw new Error(`${symbol.name}'s @wire tag is empty`)
        return value
      }
  return undefined
}
function declaredSchema(symbol) {
  const declaration = symbol.valueDeclaration
  const type = declaration && (ts.isPropertySignature(declaration) || ts.isParameter(declaration)) ? declaration.type : undefined
  const value = wireOf(type)
  const optional = symbol.flags & ts.SymbolFlags.Optional || (declaration && ts.isParameter(declaration) && declaration.questionToken)
  return value && (optional ? `${value}.optional()` : value)
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
    // A zod brand (`string & $brand<"MoveId">`) is a tag the compiler alone sees: on the wire it's the value it brands,
    // and the handler's own schema checks what the brand stands for.
    const members = type.types.filter(
      (member) =>
        !isBrand(member) &&
        (!(member.flags & ts.TypeFlags.Object) ||
          checker.getPropertiesOfType(member).length ||
          member.getStringIndexType())
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
/** zod's brand: an object whose only property is its `$brand` symbol. */
function isBrand(type) {
  if (!(type.flags & ts.TypeFlags.Object)) return false
  const properties = checker.getPropertiesOfType(type)
  return properties.length > 0 && properties.every((property) => property.escapedName.toString().startsWith("__@$brand@"))
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
const sources = program
  .getSourceFiles()
  .filter(
    (file) =>
      (file.fileName.startsWith(resolve("electron")) || file.fileName.startsWith(hostSource)) &&
      !file.fileName.endsWith("host-call-inputs.ts")
  )
/**
 * A client answers its own calls from a table typed by this one
 * (`contracts/client-calls.ts`), so their arguments are read where the
 * renderer bridge makes them instead.
 */
const clientCalls = new Set()
for (const file of sources) {
  const collect = (node, inside) => {
    const listing =
      inside ||
      (ts.isVariableDeclaration(node) && node.name.getText() === "CLIENT_CALLS")
    if (listing && ts.isStringLiteral(node)) clientCalls.add(node.text)
    ts.forEachChild(node, (child) => collect(child, listing))
  }
  collect(file, false)
}
if (!clientCalls.size) throw new Error("No CLIENT_CALLS list in the host's sources")
for (const file of sources) {
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "invokeTrustedHost" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      clientCalls.has(node.arguments[0].text)
    ) {
      const channel = node.arguments[0].text
      const args = node.arguments.slice(1).map((argument) => {
        try {
          return schema(checker.getTypeAtLocation(argument))
        } catch (error) {
          throw new Error(`${channel}/${argument.getText()}: ${error.message}`)
        }
      })
      const input = `z.tuple([${args.join(",")}])`
      if (inputs.has(channel) && inputs.get(channel) !== input)
        throw new Error(`The renderer bridge calls ${channel} two ways`)
      inputs.set(channel, input)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}
for (const call of clientCalls)
  if (!inputs.has(call))
    throw new Error(`The renderer bridge never makes the client call ${call}`)
for (const file of sources) {
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "handle" &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const channel = node.arguments[0].text
      if (channel.startsWith("mako:")) {
        const signature = checker
          .getTypeAtLocation(node.arguments[1])
          .getCallSignatures()[0]
        if (!signature) throw new Error(`No handler signature for ${channel}`)
        const args = signature.parameters.map((parameter) => {
          try {
            return declaredSchema(parameter) ?? schema(
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
        const place = file.fileName.startsWith(hostSource + "/") ? file.fileName.slice(hostSource.length + 1).split("/") : []
        if (place.length < 2) throw new Error(`${channel} is declared in ${file.fileName}, outside a domain of packages/host/src`)
        owners.set(channel, place[0])
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

/** A domain of the host that declares methods. */
export type HostMethodDomain = ${[...new Set(owners.values())].sort().map((owner) => JSON.stringify(owner)).join(" | ")}

const domains = new Map<HostChannel, HostMethodDomain>([
${[...owners].sort(([a], [b]) => a.localeCompare(b)).map(([channel, owner]) => `  [${JSON.stringify(channel)}, ${JSON.stringify(owner)}],`).join("\n")}
])

/** The domain that declares a host method, so a call can load it before its handler exists; a client call has none. */
export function hostChannelDomain(channel: HostChannel): HostMethodDomain | undefined {
  return domains.get(channel)
}

export function isHostChannel(name: string): name is HostChannel {
  return Object.hasOwn(inputs, name)
}

export const hostChannels: readonly HostChannel[] = Object.keys(inputs).filter(isHostChannel)

/** A call's argument schema, built anew; a caller that parses often keeps it (\`HostCallInputs\`). */
export function hostCallSchema<Channel extends HostChannel>(channel: Channel): HostCallInput<Channel> {
  // SAFETY: inputs[channel] is the builder HostCallInput<Channel> is the return type of; TypeScript loses that correlation when calling through a generic key.
  return inputs[channel]() as HostCallInput<Channel>
}

/** Call schemas, each built at its first use rather than when the process starts, kept for as long as their holder lives. */
export class HostCallInputs {
  readonly #built = new Map<HostChannel, z.ZodType>()

  of<Channel extends HostChannel>(channel: Channel): HostCallInput<Channel> {
    let schema = this.#built.get(channel)
    if (!schema) this.#built.set(channel, (schema = hostCallSchema(channel)))
    // SAFETY: \`#built\` only holds what hostCallSchema(channel) returned for this same key.
    return schema as HostCallInput<Channel>
  }
}
`
const file = "packages/host/src/contracts/host-call-inputs.ts"
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
