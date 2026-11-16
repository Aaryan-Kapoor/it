/**
 * The little of Bun's own `bun:ffi` that `windows-args.ts` uses, to ask Windows for the
 * standalone program's command line. Only the standalone program, which runs under Bun, loads
 * it, and the Node bundle leaves it out (see `build.mjs`).
 */
declare module 'bun:ffi' {
  export const FFIType: { readonly ptr: number; readonly i32: number }
  type Pointer = number & { readonly __pointer: unique symbol }
  export function dlopen(
    path: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ): {
    symbols: { GetCommandLineW: () => Pointer | null; lstrlenW: (at: Pointer) => number }
    close(): void
  }
  export function toArrayBuffer(at: Pointer, offset: number, length: number): ArrayBuffer
}
