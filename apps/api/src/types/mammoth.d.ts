/**
 * `mammoth` ships no type declarations and there is no `@types/mammoth`.
 * Minimal ambient types for the one function the evaluator lab's document
 * extraction (`src/lab/extract-document.ts`) uses.
 */
declare module 'mammoth' {
  export interface ExtractRawTextResult {
    readonly value: string;
    readonly messages: readonly unknown[];
  }

  export function extractRawText(input: { readonly buffer: Buffer }): Promise<ExtractRawTextResult>;
}
