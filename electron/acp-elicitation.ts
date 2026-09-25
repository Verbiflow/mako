import {
  ElicitationPropertySchema as ElicitationProperty,
  MultiSelectItems as MultiSelect,
  type ElicitationContentValue,
  type ElicitationPropertySchema,
} from "@agentclientprotocol/sdk"
import type { LiveInputQuestion } from "./shared.js"

function elicitationOptions(
  values: string[] | null | undefined,
  titled:
    | Array<{ const: string; title: string; description?: string | null }>
    | null
    | undefined
): LiveInputQuestion["options"] {
  if (titled)
    return titled.map((option) => ({
      label: option.title.trim() || option.const,
      description: option.description ?? "",
      value: option.const,
    }))
  return (values ?? []).map((value) => ({
    label: value,
    description: "",
    value,
  }))
}

export function elicitationQuestion(
  id: string,
  property: ElicitationPropertySchema,
  required: boolean
): LiveInputQuestion | null {
  if (ElicitationProperty.isString(property)) {
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: !property.enum && !property.oneOf,
      required,
      valueType: "string",
      options: elicitationOptions(property.enum, property.oneOf),
      defaultValues: property.default ? [property.default] : undefined,
    }
  }
  if (
    ElicitationProperty.isNumber(property) ||
    ElicitationProperty.isInteger(property)
  ) {
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: true,
      required,
      valueType: property.type,
      options: [],
      defaultValues:
        property.default === null || property.default === undefined
          ? undefined
          : [String(property.default)],
    }
  }
  if (ElicitationProperty.isBoolean(property)) {
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: false,
      required,
      valueType: "boolean",
      options: [
        { label: "Yes", description: "", value: "true" },
        { label: "No", description: "", value: "false" },
      ],
      defaultValues:
        property.default === null || property.default === undefined
          ? undefined
          : [String(property.default)],
    }
  }
  if (ElicitationProperty.isArray(property)) {
    const options = MultiSelect.isTitled(property.items)
      ? elicitationOptions(undefined, property.items.anyOf)
      : MultiSelect.isString(property.items)
        ? elicitationOptions(property.items.enum, undefined)
        : []
    if (options.length === 0) return null
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: false,
      required,
      valueType: "string-array",
      options,
      defaultValues: property.default ?? undefined,
    }
  }
  return null
}

export function elicitationContent(
  questions: LiveInputQuestion[],
  answers: Record<string, string[]>
): Record<string, ElicitationContentValue> | null {
  const content: Record<string, ElicitationContentValue> = {}
  for (const question of questions) {
    const values = answers[question.id] ?? []
    if (values.length === 0) {
      if (question.required) return null
      continue
    }
    if (question.valueType === "number" || question.valueType === "integer") {
      const value = Number(values[0])
      if (!Number.isFinite(value)) return null
      if (question.valueType === "integer" && !Number.isInteger(value))
        return null
      content[question.id] = value
    } else if (question.valueType === "boolean") {
      content[question.id] = values[0] === "true"
    } else if (question.valueType === "string-array") {
      content[question.id] = values
    } else {
      content[question.id] = values[0] ?? ""
    }
  }
  return content
}
