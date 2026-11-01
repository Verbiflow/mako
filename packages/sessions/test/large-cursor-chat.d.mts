export type ChatRow = { id: string; data: Buffer; root: boolean }

export declare function largeCursorChat(options?: { turns?: number; steps?: number; seed?: number; agentId?: string }): { rows: ChatRow[]; agentId: string }
