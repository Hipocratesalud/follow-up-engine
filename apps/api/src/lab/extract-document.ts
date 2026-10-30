/** Document text extraction lives in the runtime (the order agent reads PDFs too). */
export {
  type DocumentExtractionError,
  type DocumentExtractionFailure,
  type DocumentExtractionResult,
  extractDocumentText,
  MAX_LAB_DOCUMENT_BYTES,
} from '@follow-up-engine/runtime';
