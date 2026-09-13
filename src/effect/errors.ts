/**
 * ZATCA Effect error model (Effect v4)
 *
 * Single source of the tagged error surface (the former
 * `src/invoice/effect-errors.ts` duplicate was consolidated here).
 *
 * Schema.TaggedError classes mirroring the legacy ZatcaError/ZatcaErrorCode
 * surface, plus bidirectional converters so:
 *
 * - legacy promise paths can convert a caught ZatcaError into a typed,
 *   yieldable tagged error, and
 * - Effect workflows surfaced through promise wrappers keep throwing the
 *   original ZatcaError instances (back-compat is a hard requirement).
 */

import { Effect, Schema } from 'effect';
import { ZatcaError, ZatcaErrorCode } from '../errors.js';

// ---- Tagged errors ----

/**
 * An API-level error response (non-transport). `status`/`body`/`code` are
 * optional so API-level failures that carry neither (e.g. unknown errors
 * funneled through `toZatcaEffectError`) use the same class.
 */
export class ZatcaApiError extends Schema.TaggedError<ZatcaApiError>()(
  'ZatcaApiError',
  {
    status: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.String),
    message: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** Transport-level connection failure (DNS, refused, reset, ...). */
export class ZatcaConnectionError extends Schema.TaggedError<ZatcaConnectionError>()(
  'ZatcaConnectionError',
  {
    message: Schema.String,
    causeCode: Schema.optional(Schema.String),
    syscall: Schema.optional(Schema.String),
    hostname: Schema.optional(Schema.String),
    // Holds the original error so promise wrappers can restore
    // `ZatcaError.details` by identity.
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** The request exceeded its configured time budget. */
export class ZatcaTimeoutError extends Schema.TaggedError<ZatcaTimeoutError>()(
  'ZatcaTimeoutError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const ZatcaDiagnosticMessage = Schema.Struct({
  code: Schema.String,
  category: Schema.String,
  message: Schema.String,
});

/** Validation diagnostics shape produced by `extractValidationDiagnostics`. */
const ZatcaValidationDiagnostics = Schema.Struct({
  error: Schema.optional(ZatcaDiagnosticMessage),
  warnings: Schema.Array(ZatcaDiagnosticMessage),
  alerts: Schema.Array(
    Schema.Struct({
      severity: Schema.Union([Schema.Literal('error'), Schema.Literal('warning')]),
      code: Schema.String,
      category: Schema.String,
      message: Schema.String,
    }),
  ),
});

/** Validation of an invoice/response produced diagnostics. */
export class ZatcaValidationError extends Schema.TaggedError<ZatcaValidationError>()(
  'ZatcaValidationError',
  {
    message: Schema.String,
    diagnostics: ZatcaValidationDiagnostics,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type ZatcaEffectError =
  | ZatcaApiError
  | ZatcaConnectionError
  | ZatcaTimeoutError
  | ZatcaValidationError;

/** Errors the retry policy may transparently retry. */
export type ZatcaRetryableError = ZatcaApiError | ZatcaConnectionError | ZatcaTimeoutError;

const TAGGED_ERROR_TAGS: ReadonlySet<string> = new Set([
  'ZatcaApiError',
  'ZatcaConnectionError',
  'ZatcaTimeoutError',
  'ZatcaValidationError',
]);

export const isZatcaEffectError = (u: unknown): u is ZatcaEffectError =>
  typeof u === 'object' &&
  u !== null &&
  '_tag' in u &&
  typeof (u as { _tag: unknown })._tag === 'string' &&
  TAGGED_ERROR_TAGS.has((u as { _tag: string })._tag);

// ---- Legacy <-> tagged conversion ----

interface LegacyCauseShape {
  code?: string;
  syscall?: string;
  hostname?: string;
}

interface LegacyDetailsCarrier {
  cause?: LegacyCauseShape;
}

/** Legacy `ZatcaError.details` may be the original error or a cause shape. */
const extractLegacyCause = (details: unknown): LegacyCauseShape | undefined => {
  const carrier = details as LegacyDetailsCarrier | undefined;
  return carrier?.cause ?? (details as LegacyCauseShape | undefined);
};

/**
 * Converts a caught legacy `ZatcaError` (from the promise paths) into the
 * matching tagged error so Effect workflows can fail with a typed error.
 */
export const toTaggedZatcaError = (error: ZatcaError): ZatcaEffectError => {
  switch (error.code) {
    case ZatcaErrorCode.API_TIMEOUT:
      return new ZatcaTimeoutError({ message: error.message });
    case ZatcaErrorCode.API_CONNECTION_ERROR: {
      const cause = extractLegacyCause(error.details);
      return new ZatcaConnectionError({
        message: error.message,
        causeCode: cause?.code,
        syscall: cause?.syscall,
        hostname: cause?.hostname,
        cause: error.details,
      });
    }
    case ZatcaErrorCode.VALIDATION_ERROR:
      return new ZatcaValidationError({
        message: error.message,
        diagnostics: (error.details ?? { warnings: [], alerts: [] }) as Schema.Schema.Type<
          typeof ZatcaValidationDiagnostics
        >,
      });
    default:
      return new ZatcaApiError({
        status: 0,
        body: '',
        message: error.message,
        code: error.code,
      });
  }
};

/**
 * Runtime guard for legacy `ZatcaError.details` carrying validation
 * diagnostics. Legacy validators also throw other shapes (e.g.
 * `{ errors: [...] }`), which must not be smuggled into the schema-validated
 * `diagnostics` field — those fall back to empty diagnostics while `cause`
 * keeps the original error (details included).
 */
const asValidationDiagnostics = (
  details: unknown,
): Schema.Schema.Type<typeof ZatcaValidationDiagnostics> =>
  typeof details === 'object' &&
  details !== null &&
  ['error', 'warnings', 'alerts'].some((key) => key in details)
    ? (details as Schema.Schema.Type<typeof ZatcaValidationDiagnostics>)
    : { warnings: [], alerts: [] };

/**
 * Maps any caught failure to the matching tagged error so no failure escapes
 * the typed error channel (absorbed from the former
 * `src/invoice/effect-errors.ts`).
 *
 * ZatcaError codes map by meaning; everything else (including plain Errors and
 * unexpected rejections) lands on ZatcaApiError. The original error always
 * travels as `cause`, and validation failures additionally carry their
 * diagnostics when present.
 */
export const toZatcaEffectError = (error: unknown): ZatcaEffectError => {
  if (error instanceof ZatcaError) {
    const message = error.message;
    switch (error.code) {
      case ZatcaErrorCode.API_TIMEOUT:
        return new ZatcaTimeoutError({ message, cause: error });
      case ZatcaErrorCode.API_CONNECTION_ERROR:
        return new ZatcaConnectionError({ message, cause: error });
      case ZatcaErrorCode.VALIDATION_ERROR:
        return new ZatcaValidationError({
          message,
          diagnostics: asValidationDiagnostics(error.details),
          cause: error,
        });
      default:
        return new ZatcaApiError({ status: 0, body: '', message, code: error.code, cause: error });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ZatcaApiError({ status: 0, body: '', message, code: ZatcaErrorCode.API_ERROR, cause: error });
};

const LEGACY_CODE_VALUES: ReadonlySet<string> = new Set(
  Object.values(ZatcaErrorCode) as Array<string>,
);

/**
 * Converts a tagged error back into the legacy `ZatcaError` so promise
 * wrappers keep throwing the exact error type callers already handle.
 */
export const toZatcaError = (error: ZatcaEffectError): ZatcaError => {
  switch (error._tag) {
    case 'ZatcaConnectionError':
      return new ZatcaError(error.message, ZatcaErrorCode.API_CONNECTION_ERROR, error.cause);
    case 'ZatcaTimeoutError':
      return new ZatcaError(error.message, ZatcaErrorCode.API_TIMEOUT);
    case 'ZatcaValidationError':
      return new ZatcaError(error.message, ZatcaErrorCode.VALIDATION_ERROR, error.diagnostics);
    case 'ZatcaApiError': {
      const code =
        error.code !== undefined && LEGACY_CODE_VALUES.has(error.code)
          ? (error.code as ZatcaErrorCode)
          : ZatcaErrorCode.API_ERROR;
      return new ZatcaError(error.message, code, {
        status: error.status ?? 0,
        body: error.body ?? '',
      });
    }
  }
};

/**
 * Runs an Effect workflow behind a legacy promise API: rejections that are
 * tagged ZATCA errors are converted back to `ZatcaError` instances; anything
 * else propagates untouched.
 */
export const runZatcaEffect = <A>(
  effect: Effect.Effect<A, ZatcaEffectError, never>,
): Promise<A> =>
  Effect.runPromise(effect).catch((cause: unknown) => {
    throw isZatcaEffectError(cause) ? toZatcaError(cause) : cause;
  });
