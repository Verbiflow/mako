import type { JsonObject } from "../../contracts/json.js"
import type { RoutedThread } from "../../contracts/native-routing.js"
import { layerOf } from "../mako-layer.js"
import { codexLayer } from "./layer.js"

/** What `thread/start`, `thread/resume` and `thread/fork` carry in `config` for native routing (`codexLayer`). */
export function codexRoutingConfig(conversation: string, routing: (() => RoutedThread) | undefined): JsonObject {
  return codexLayer.apply(layerOf({ nativeRouting: routing }), conversation).config()
}
