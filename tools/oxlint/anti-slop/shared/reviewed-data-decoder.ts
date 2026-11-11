import { relative, sep } from "node:path";
import type { Context, ESTree, Scope, Variable } from "@oxlint/plugins";

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

/** Resolve the actual reference, including block, catch and loop shadowing. */
function referencedVariable(context: Context, identifier: ESTree.IdentifierReference): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const reference = scope.references.find(entry => entry.identifier === identifier);
    if (reference !== undefined) return reference.resolved;
    scope = scope.upper;
  }
  return null;
}

/** The one classification declaration in the helper's own scope/array branch. */
function classifierDeclaration(owner: ESTree.ArrowFunctionExpression, name: "length" | "key"): ESTree.VariableDeclarator | null {
  if (owner.body.type !== "BlockStatement") return null;
  const candidates: ESTree.VariableDeclarator[] = [];
  const collectLength = (statement: ESTree.Statement): void => {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") return;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === "Identifier" && declaration.id.name === "length") candidates.push(declaration);
    }
  };
  for (const statement of owner.body.body) {
    if (name === "length") {
      collectLength(statement);
      if (statement.type === "IfStatement" && statement.test.type === "Identifier" && statement.test.name === "array"
        && statement.consequent.type === "BlockStatement") {
        for (const nested of statement.consequent.body) collectLength(nested);
      }
    } else if (statement.type === "ForOfStatement" && statement.left.type === "VariableDeclaration"
      && statement.left.kind === "const" && statement.left.declarations.length === 1) {
      const declaration = statement.left.declarations[0];
      if (declaration?.id.type === "Identifier" && declaration.id.name === "key") candidates.push(declaration);
    }
  }
  // Ambiguous classifier declarations get no exemption; never select the first by name.
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

function isClassifierReference(context: Context, owner: ESTree.ArrowFunctionExpression, variable: Variable, name: "length" | "key"): boolean {
  const declaration = classifierDeclaration(owner, name);
  return declaration !== null && context.sourceCode.getDeclaredVariables(declaration).includes(variable);
}

/** Only primitive/container/own-key classifications used by this bounded decoder. */
export function isReviewedDecoderTypeof(context: Context, node: ESTree.UnaryExpression): boolean {
  if (!configured(context) || node.operator !== "typeof" || node.argument.type !== "Identifier") return false;
  const owner = nearestFunction(node);
  if (owner === null || !isCopy(context, owner)) return false;
  const comparison = node.parent;
  if (comparison.type !== "BinaryExpression" || comparison.left !== node
    || (comparison.operator !== "===" && comparison.operator !== "!==") || comparison.right.type !== "Literal") return false;
  const variable = referencedVariable(context, node.argument);
  if (variable === null) return false;
  const value = comparison.right.value;
  const rawParameter = owner.params[0];
  if (rawParameter?.type === "Identifier" && variable.identifiers.includes(rawParameter)) {
    return value === "string" || value === "boolean" || value === "number" || value === "object";
  }
  return value === "number" && isClassifierReference(context, owner, variable, "length")
    || value === "string" && isClassifierReference(context, owner, variable, "key");
}
