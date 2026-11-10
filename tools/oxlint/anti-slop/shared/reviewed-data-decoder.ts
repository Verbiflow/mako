import { relative, sep } from "node:path";
import type { Context, ESTree } from "@oxlint/plugins";

// An explicit reviewed lint boundary, not a trust or runtime authorization check.
// There is deliberately no file-wide, parser-prefix or inherited callback exemption.
export const reviewedDataDecoderSchema = {
  type: "object",
  properties: {
    module: { enum: ["packages/protocol/src/handoff-project.ts"] },
    export: { enum: ["plainProtocolValue"] },
    result: { enum: ["PlainProtocolValue"] },
  },
  required: ["module", "export", "result"],
  additionalProperties: false,
} as const;

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function nearestFunction(node: ESTree.Node): RuntimeFunction | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null) {
    if (current.type === "ArrowFunctionExpression" || current.type === "FunctionDeclaration" || current.type === "FunctionExpression") return current;
    current = current.parent;
  }
  return null;
}

function configured(context: Context): boolean {
  const option = context.options[0];
  if (typeof option !== "object" || option === null || Array.isArray(option)) return false;
  const decoder = option.reviewedDataDecoder;
  return typeof decoder === "object" && decoder !== null && !Array.isArray(decoder)
    && decoder.module === "packages/protocol/src/handoff-project.ts"
    && decoder.export === "plainProtocolValue" && decoder.result === "PlainProtocolValue"
    && relative(context.cwd, context.filename).split(sep).join("/") === decoder.module;
}

function namedResult(node: RuntimeFunction): boolean {
  const result = node.returnType?.typeAnnotation;
  return result?.type === "TSTypeReference" && result.typeName.type === "Identifier"
    && result.typeName.name === "PlainProtocolValue" && !result.typeArguments
    && !node.typeParameters && !node.async && !node.generator;
}

function parameter(node: ESTree.ParamPattern | undefined, name: string, type: "TSUnknownKeyword" | "TSNumberKeyword"): boolean {
  return node?.type === "Identifier" && node.name === name && node.typeAnnotation?.typeAnnotation.type === type && !node.optional;
}

function isDecoder(node: ESTree.Node): node is ESTree.Function & { type: "FunctionDeclaration" } {
  return node.type === "FunctionDeclaration" && node.id?.name === "plainProtocolValue"
    && node.parent.type === "ExportNamedDeclaration" && node.parent.declaration === node
    && node.parent.parent.type === "Program" && node.body !== null
    && namedResult(node) && node.params.length === 1 && parameter(node.params[0], "input", "TSUnknownKeyword");
}

function isCopy(context: Context, node: ESTree.Node): node is ESTree.ArrowFunctionExpression {
  if (node.type !== "ArrowFunctionExpression" || !namedResult(node) || node.params.length !== 2
    || !parameter(node.params[0], "value", "TSUnknownKeyword") || !parameter(node.params[1], "depth", "TSNumberKeyword")) return false;
  const declarator = node.parent;
  if (declarator.type !== "VariableDeclarator" || declarator.init !== node || declarator.id.type !== "Identifier" || declarator.id.name !== "copy") return false;
  const declaration = declarator.parent;
  if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const" || declaration.declarations.length !== 1) return false;
  const block = declaration.parent;
  if (block.type !== "BlockStatement" || !isDecoder(block.parent) || block.parent.body !== block) return false;
  // Require a recursive call to this exact lexical binding, not a same-named callback/helper.
  return context.sourceCode.getDeclaredVariables(declarator).some(variable =>
    variable.references.some(reference => reference.resolved === variable
      && reference.identifier.parent.type === "CallExpression"
      && reference.identifier.parent.callee === reference.identifier
      && nearestFunction(reference.identifier) === node));
}

/** Only the honest raw input and the direct recursive copier's raw value parameter. */
export function isReviewedDecoderInput(context: Context, owner: ESTree.Node, input: ESTree.ParamPattern): boolean {
  return configured(context) && (isDecoder(owner) || isCopy(context, owner)) && owner.params[0] === input;
}

/** Only primitive/container/own-key classifications used by this bounded decoder. */
export function isReviewedDecoderTypeof(context: Context, node: ESTree.UnaryExpression): boolean {
  if (!configured(context) || node.operator !== "typeof" || node.argument.type !== "Identifier") return false;
  const owner = nearestFunction(node);
  if (owner === null || !isCopy(context, owner)) return false;
  const comparison = node.parent;
  if (comparison.type !== "BinaryExpression" || comparison.left !== node
    || (comparison.operator !== "===" && comparison.operator !== "!==") || comparison.right.type !== "Literal") return false;
  const value = comparison.right.value;
  return node.argument.name === "value" ? value === "string" || value === "boolean" || value === "number" || value === "object"
    : node.argument.name === "length" ? value === "number"
    : node.argument.name === "key" && value === "string";
}
