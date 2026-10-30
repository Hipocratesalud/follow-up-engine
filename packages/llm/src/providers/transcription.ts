import { createHash } from 'node:crypto';
import { LlmConfigError, LlmProviderError, LlmTimeoutError } from '../errors.ts';
import type { FetchLike } from './chat-completions.ts';
import { META_API_BASE_URL } from './meta.ts';

/** One transcription request to a provider. Contains no tenant or patient identifiers. */
export interface TranscriptionRequest {
  readonly model: string;
  readonly audio: Uint8Array;
  /** MIME type of the audio (`audio/wav`). */
  readonly contentType: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface TranscriptionResult {
  readonly transcript: string;
  /** Length of the audio, as the provider reports it. */
  readonly durationMs?: number;
  readonly latencyMs: number;
  readonly provider: string;
  readonly model: string;
}

/** A speech-to-text vendor (Meta Muse Voice Transcribe, or the fake used in CI and demos). */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Default Muse Voice transcription model (https://dev.meta.ai/docs/models). */
export const META_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';

/** Encoding names the ASR endpoint accepts, by MIME type. */
const ENCODINGS: Readonly<Record<string, string>> = {
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/wave': 'WAV',
};

export interface MetaTranscriberOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Muse Voice Transcribe on the Meta Model API: `POST /v1/asr/transcribe`,
 * multipart with a `request` JSON part (model, encoding, push-to-talk
 * mode) and the `audio` part. Replies `{ transcript, audioDurationMs }`.
 */
export function createMetaTranscriber(options: MetaTranscriberOptions): TranscriptionProvider {
  if (options.apiKey.trim() === '') {
    throw new LlmConfigError('Meta Model API key is empty: set META_API_KEY');
  }
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => performance.now());
  const url = `${(options.baseUrl ?? META_API_BASE_URL).replace(/\/+$/, '')}/asr/transcribe`;
  return {
    name: 'meta',
    async transcribe(request) {
      const encoding = ENCODINGS[request.contentType.split(';')[0]?.trim().toLowerCase() ?? ''];
      if (encoding === undefined) {
        throw new LlmProviderError('meta', `Unsupported audio type ${request.contentType}`, {
          retryable: false,
        });
      }
      const form = new FormData();
      form.append(
        'request',
        new Blob(
          [JSON.stringify({ model: request.model, audioEncoding: encoding, mode: 'PUSH_TO_TALK' })],
          { type: 'application/json' },
        ),
      );
      form.append('audio', new Blob([request.audio], { type: 'audio/wav' }), 'audio.wav');
      const signals: AbortSignal[] = [];
      if (request.signal) signals.push(request.signal);
      if (request.timeoutMs !== undefined) signals.push(AbortSignal.timeout(request.timeoutMs));
      const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
      const started = now();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
          body: form,
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        if (signal?.aborted === true) {
          throw new LlmTimeoutError('meta', request.timeoutMs ?? 0);
        }
        throw new LlmProviderError('meta', 'Network error calling the ASR endpoint', {
          retryable: true,
          cause,
        });
      }
      if (!response.ok) {
        throw new LlmProviderError('meta', `HTTP ${String(response.status)} from ASR`, {
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      const body: unknown = await response.json();
      const transcript =
        isRecord(body) && typeof body['transcript'] === 'string' ? body['transcript'] : '';
      const duration = isRecord(body) ? body['audioDurationMs'] : undefined;
      return {
        transcript: transcript.trim(),
        ...(typeof duration === 'number' ? { durationMs: duration } : {}),
        latencyMs: Math.round(now() - started),
        provider: 'meta',
        model: request.model,
      };
    },
  };
}

/** sha256 hex of a byte array (keys of the fake transcriber and the scripted vision reader). */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic transcriber for CI and the scripted demo: known audio (by
 * sha256) gets its scripted transcript; anything else an empty one.
 */
export function createFakeTranscriber(
  transcripts: Readonly<Record<string, string>> = {},
): TranscriptionProvider {
  return {
    name: 'fake',
    transcribe(request) {
      return Promise.resolve({
        transcript: transcripts[sha256Hex(request.audio)] ?? '',
        // 16-bit mono 16 kHz WAV: bytes / 32 per millisecond (a fake, close enough).
        durationMs: Math.round(request.audio.byteLength / 32),
        latencyMs: 0,
        provider: 'fake',
        model: request.model,
      });
    },
  };
}
