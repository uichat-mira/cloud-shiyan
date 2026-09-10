import type { SttProvider, SttRequest, SttResult, TranscriptSegment } from './stt';

const MODEL = '@cf/openai/whisper-large-v3-turbo';

export type WorkersAiLike = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

type AudioLoader = (objectKey: string) => Promise<string>;

type WhisperSegment = {
  start?: number;
  end?: number;
  text?: string;
};

type WhisperResponse = {
  text?: string;
  transcription_info?: {
    text?: string;
    word_count?: number;
  };
  word_count?: number;
  language?: string;
  segments?: WhisperSegment[];
  request_id?: string;
};

const normalizeSegments = (segments: WhisperSegment[] | undefined): TranscriptSegment[] | undefined => {
  if (!segments?.length) return undefined;
  const normalized = segments.flatMap((segment) => {
    if (
      typeof segment.start !== 'number' ||
      typeof segment.end !== 'number' ||
      typeof segment.text !== 'string'
    ) {
      return [];
    }
    return [
      {
        startMs: Math.max(0, Math.round(segment.start * 1000)),
        endMs: Math.max(0, Math.round(segment.end * 1000)),
        text: segment.text,
      },
    ];
  });
  return normalized.length ? normalized : undefined;
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const isRetryableMessage = (message: string): boolean =>
  /\b(408|425|429|5\d\d)\b|timeout|timed out|temporar|unavailable|rate.?limit|connection|network/iu.test(
    message,
  );

export const providerFailure = (error: unknown): SttResult => {
  const message = errorMessage(error, 'Workers AI transcription failed');
  const retryable = isRetryableMessage(message);
  return {
    ok: false,
    error: {
      kind: retryable ? 'retryable' : 'terminal',
      code: retryable ? 'stt_provider_retryable' : 'stt_provider_error',
      message,
    },
  };
};

const audioLoadFailure = (error: unknown): SttResult => {
  const message = errorMessage(error, 'Audio asset could not be read');
  const retryable = isRetryableMessage(message);
  return {
    ok: false,
    error: {
      kind: retryable ? 'retryable' : 'terminal',
      code: retryable ? 'audio_asset_read_retryable' : 'audio_asset_unreadable',
      message,
    },
  };
};

export class WorkersAiSttProvider implements SttProvider {
  constructor(
    private readonly ai: WorkersAiLike,
    private readonly loadAudioBase64: AudioLoader,
  ) {}

  async transcribe(request: SttRequest): Promise<SttResult> {
    let audio: string;
    try {
      audio = await this.loadAudioBase64(request.audioObjectKey);
    } catch (error) {
      return audioLoadFailure(error);
    }

    try {
      const raw = (await this.ai.run(MODEL, {
        audio,
        task: 'transcribe',
        ...(request.initialPrompt ? { initial_prompt: request.initialPrompt } : {}),
      })) as WhisperResponse;
      const text = raw.transcription_info?.text ?? raw.text;
      if (typeof text !== 'string' || !text.trim()) {
        return {
          ok: false,
          error: {
            kind: 'terminal',
            code: 'stt_empty_transcript',
            message: 'Workers AI returned no transcript text',
          },
        };
      }

      const segments = normalizeSegments(raw.segments);
      const wordCount = raw.transcription_info?.word_count ?? raw.word_count;

      return {
        ok: true,
        value: {
          text,
          ...(raw.language ? { language: raw.language } : {}),
          ...(segments ? { segments } : {}),
          provider: 'cloudflare-workers-ai',
          model: MODEL,
          ...(raw.request_id ? { providerRequestId: raw.request_id } : {}),
          ...(typeof wordCount === 'number' ? { providerMetadata: { wordCount } } : {}),
        },
      };
    } catch (error) {
      return providerFailure(error);
    }
  }
}
