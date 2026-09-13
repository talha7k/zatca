/**
 * ZatcaHttp — Effect v4 Context service wrapping global fetch.
 *
 * Encapsulates what the legacy `ZatcaHttpClient.request` did at the transport
 * level: perform the HTTP call, read the body (with the Bun gzip fallback),
 * enforce the timeout budget (Effect.timeout instead of AbortController) and
 * map transport failures to tagged errors with the exact legacy message
 * formats:
 *
 * - connection: `ZATCA API connection failed: <message> (<code>: <syscall> <hostname>)`
 * - timeout:    `ZATCA API request timed out after <timeout>ms`
 */

import { Context, Effect, Layer } from 'effect';
import * as Duration from 'effect/Duration';
import { createUnzip } from 'node:zlib';
import {
  ZatcaConnectionError,
  ZatcaTimeoutError,
} from './errors.js';

export const DEFAULT_ZATCA_TIMEOUT_MS = 30000;

export interface ZatcaHttpRequest {
  method: string;
  /** Absolute URL (the workflows own base-url + path composition). */
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Overrides the layer's default timeout for this request, in milliseconds. */
  timeoutMs?: number;
}

export interface ZatcaHttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface ZatcaFetchResponseLike {
  status: number;
  headers: { forEach: (callback: (value: string, key: string) => void) => void };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ZatcaFetchLike = (
  url: string,
  init: RequestInit,
) => Promise<ZatcaFetchResponseLike>;

/**
 * HTTP transport for ZATCA API calls. Yields the raw response for any HTTP
 * status (status-based decisions belong to the workflows); fails only with
 * transport errors (connection failure / timeout).
 */
export class ZatcaHttp extends Context.Service<
  ZatcaHttp,
  {
    request(req: ZatcaHttpRequest): Effect.Effect<
      ZatcaHttpResponse,
      ZatcaConnectionError | ZatcaTimeoutError
    >;
  }
>()('@talha7k/zatca/effect/ZatcaHttp') {}

export interface ZatcaHttpLayerOptions {
  /** Default request timeout in milliseconds (defaults to 30000). */
  timeoutMs?: number;
}

type CauseShape = { code?: string; syscall?: string; hostname?: string };

const connectionMessage = (error: unknown): string => {
  const message = (error as Error).message;
  const cause = ((error as Error & { cause?: CauseShape }).cause ?? {}) as CauseShape;
  const causeInfo = cause.code
    ? ` (${cause.code}${cause.syscall ? `: ${cause.syscall}` : ''}${
        cause.hostname ? ` ${cause.hostname}` : ''
      })`
    : '';
  return `ZATCA API connection failed: ${message}${causeInfo}`;
};

const timeoutMessage = (timeoutMs: number): string =>
  `ZATCA API request timed out after ${timeoutMs}ms`;

const mapFetchError = (error: unknown, timeoutMs: number): ZatcaConnectionError | ZatcaTimeoutError => {
  if ((error as Error).name === 'AbortError') {
    return new ZatcaTimeoutError({ message: timeoutMessage(timeoutMs) });
  }
  const cause = ((error as Error & { cause?: CauseShape }).cause ?? {}) as CauseShape;
  return new ZatcaConnectionError({
    message: connectionMessage(error),
    causeCode: cause.code,
    syscall: cause.syscall,
    hostname: cause.hostname,
    cause: error,
  });
};

/**
 * Reads the response body: text() first, then the manual gzip fallback (Bun
 * sometimes fails to decompress gzip responses), then the raw status line.
 */
const readBody = async (response: ZatcaFetchResponseLike): Promise<string> => {
  try {
    return await response.text();
  } catch {
    try {
      const arrayBuf = await response.arrayBuffer();
      const chunks: Array<Buffer> = [];
      const gunzip = createUnzip();
      gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        gunzip.on('end', resolve);
        gunzip.on('error', reject);
        gunzip.end(Buffer.from(arrayBuf));
      });
      return Buffer.concat(chunks).toString('utf8');
    } catch {
      return `HTTP ${response.status}`;
    }
  }
};

const makeRequest = (
  fetchSource: () => ZatcaFetchLike,
  defaultTimeoutMs: number,
): ((req: ZatcaHttpRequest) => Effect.Effect<ZatcaHttpResponse, ZatcaConnectionError | ZatcaTimeoutError>) =>
  Effect.fn('ZatcaHttp.request')(function*(req: ZatcaHttpRequest) {
    const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        // fetchSource is resolved at call time so runtime stubbing of
        // globalThis.fetch keeps working (legacy test & user behavior).
        const response = await fetchSource()(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal,
        });
        const body = await readBody(response);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: response.status, body, headers };
      },
      catch: (error) => mapFetchError(error, timeoutMs),
    }).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.catchTag('TimeoutError', () =>
        Effect.fail(new ZatcaTimeoutError({ message: timeoutMessage(timeoutMs) })),
      ),
    );
  });

/** Live layer: performs real requests via `globalThis.fetch`. */
export const layerZatcaHttp = (options: ZatcaHttpLayerOptions = {}): Layer.Layer<ZatcaHttp> =>
  Layer.effect(
    ZatcaHttp,
    Effect.succeed(
      ZatcaHttp.of({
        request: makeRequest(() => globalThis.fetch as unknown as ZatcaFetchLike, options.timeoutMs ?? DEFAULT_ZATCA_TIMEOUT_MS),
      }),
    ),
  );

/** Test layer: injects a stub fetch implementation, never touching globalThis. */
export const layerZatcaHttpTest = (
  fetchImpl: ZatcaFetchLike,
  options: ZatcaHttpLayerOptions = {},
): Layer.Layer<ZatcaHttp> =>
  Layer.effect(
    ZatcaHttp,
    Effect.succeed(
      ZatcaHttp.of({
        request: makeRequest(() => fetchImpl, options.timeoutMs ?? DEFAULT_ZATCA_TIMEOUT_MS),
      }),
    ),
  );
