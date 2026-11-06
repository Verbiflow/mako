export const TRANSCRIPT_BUILDS: {
  [build in "esm" | "cjs"]: { target: string; writer: string; store: string; write: string; fs: string; child: string; chunks: string }
}
