import type { Thread, ThreadRef } from "../dist/format.js"
import type { NativeFile, SessionProvider } from "../dist/providers/types.js"
import type { NativeStores } from "../dist/read-only-sqlite.js"

export declare const FACT: string

export type HarnessFixture = {
  name: string
  provider(home: string): SessionProvider
  emit(home: string, cwd: string): Promise<object>
}

export declare function harnessFixtures(stores: NativeStores): HarnessFixture[]

export type ConversationEntry = { type: string; text: string | null; name: string | null; input: string | null; output: string | null }

export declare function conversation(read: Thread | null): ConversationEntry[]

export declare function sessionIn(provider: SessionProvider, nativeId?: string): Promise<{ file: NativeFile; ref: ThreadRef } | undefined>
