// `mammoth` ships no types: every program that compiles this file (runtime, api, worker) needs them.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- an ambient module declaration, not an import
/// <reference path="./types/mammoth.d.ts" />
import { extractRawText } from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

/** Largest document the evaluator lab's upload accepts. */
export const MAX_LAB_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * A PDF whose text layer averages fewer letters and digits than this per
 * page has no usable text: it is a scan (each page an image, perhaps with a
 * stray page number or a scanner's stamp). A one-page lab report with a
 * text layer holds hundreds (the samples: about 250); a scan, zero.
 */
export const MIN_TEXT_LAYER_CHARS_PER_PAGE = 40;

export type DocumentExtractionError =
  | 'too_large'
  | 'empty'
  | 'unsupported_image'
  | 'unsupported_type'
  | 'unreadable'
  /** A PDF with no usable text layer: a lab report reads it as a scan (vision); a note cannot. */
  | 'scanned_pdf';

export interface DocumentExtractionResult {
  readonly text: string;
}

export interface DocumentExtractionFailure {
  readonly error: DocumentExtractionError;
}

const TEXT_TYPES = new Set(['text/plain']);
const PDF_TYPES = new Set(['application/pdf']);
const DOCX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function isImageContentType(contentType: string): boolean {
  return contentType.startsWith('image/');
}

function finished(text: string): DocumentExtractionResult | DocumentExtractionFailure {
  const trimmed = text.trim();
  return trimmed === '' ? { error: 'empty' } : { text: trimmed };
}

/** Letters and digits in a text (any script): what a text layer must hold to be read as text. */
export function textLayerChars(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/** Whether a PDF's extracted text is too thin to be its content (see {@link MIN_TEXT_LAYER_CHARS_PER_PAGE}). */
export function isScannedPdfText(text: string, pages: number): boolean {
  return textLayerChars(text) < MIN_TEXT_LAYER_CHARS_PER_PAGE * Math.max(1, pages);
}

/**
 * Extracts plain text from a document (the evaluator lab's uploads,
 * docs/deploy.md#hosted-demo; a lab report PDF the patient sends the order
 * agent): TXT read as UTF-8, PDF with `unpdf` (pure JS, pdf.js underneath —
 * no native deps, builds in Dockerfile.demo), DOCX with `mammoth`. Images
 * hold no text to extract (`unsupported_image`): a photo of a lab report is
 * read by the vision model instead (`PatientMediaReader.readLabPhoto`). The
 * text of a note then goes through the normal FHIR ingestion path; the
 * text of a lab report through the lab-result reading. A PDF with no usable
 * text layer (a scan, {@link isScannedPdfText}) is `scanned_pdf`: a lab
 * report is then read from its pages by the vision model, like a photo.
 */
export async function extractDocumentText(file: {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}): Promise<DocumentExtractionResult | DocumentExtractionFailure> {
  if (file.data.byteLength === 0) {
    return { error: 'empty' };
  }
  if (file.data.byteLength > MAX_LAB_DOCUMENT_BYTES) {
    return { error: 'too_large' };
  }
  const contentType = file.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (isImageContentType(contentType)) {
    return { error: 'unsupported_image' };
  }
  const lowerName = file.filename.toLowerCase();
  try {
    if (PDF_TYPES.has(contentType) || lowerName.endsWith('.pdf')) {
      // pdf.js detaches the buffer it is given: read a copy, so the caller's bytes stay usable.
      const document = await getDocumentProxy(new Uint8Array(file.data));
      const { text, totalPages } = await extractText(document, { mergePages: true });
      if (isScannedPdfText(text, totalPages)) return { error: 'scanned_pdf' };
      return finished(text);
    }
    if (DOCX_TYPES.has(contentType) || lowerName.endsWith('.docx')) {
      const result = await extractRawText({ buffer: Buffer.from(file.data) });
      return finished(result.value);
    }
    if (TEXT_TYPES.has(contentType) || lowerName.endsWith('.txt')) {
      return finished(new TextDecoder('utf-8').decode(file.data));
    }
  } catch {
    return { error: 'unreadable' };
  }
  return { error: 'unsupported_type' };
}
