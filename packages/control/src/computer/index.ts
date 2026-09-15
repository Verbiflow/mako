export { normalizeDriverSchema } from "./driver-schema.js"
export {
  BACKGROUND_INPUT_LADDER,
  KEYBOARD_TOOLS,
  KEY_ROUTE_ADVICE,
  keyRouteAdvice,
} from "./policy.js"
export {
  ElementSchema,
  MENU_ROLES,
  PASSIVE_ROLES,
  WindowRecordSchema,
  diffLines,
  elementLine,
  elementLines,
  lineIdentity,
  toolResultData,
  toolResultError,
  windowKind,
  withWindowKinds,
  withoutMenuBar,
  type Element,
  type LineOptions,
  type ToolResult,
  type ViewDelta,
  type WindowKind,
  type WindowRecord,
} from "./projection.js"
export {
  HELPER_REFERENCE,
  MAKO_ACTION_FLAGS,
  actionLine,
  programProperties,
  renderReference,
  returnsOf,
  signatureOf,
  summaryOf,
  type DriverTool,
} from "./reference.js"
export {
  computerHelpers,
  type Action,
  type Actions,
  type ComputerHelpers,
  type Target,
} from "./steps.js"
