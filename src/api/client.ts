/**
 * ZATCA Fatoora API HTTP Client
 *
 * Low-level HTTP wrapper for all ZATCA API communication.
 * Handles authentication headers, timeouts, and error wrapping.
 *
 * The Effect building blocks live in the `src/effect/` leaf modules
 * (`errors.js`, `http.js`, `schedule.js`), which never import back into
 * `src/api/*` — this file imports those leaves directly. The first-class
 * Effect twins (`requestEffect`, `runZatcaRequest`) are defined here and
 * re-exported through the `src/effect/index.ts` barrel for Effect consumers.
 */

import { Effect } from 'effect';
import type {
  ZatcaApiConfig,
  ZatcaCredentials,
} from '../types.js';
import {
  ZatcaHttp,
  layerZatcaHttp,
  type ZatcaHttpLayerOptions,
  type ZatcaHttpRequest,
  type ZatcaHttpResponse,
} from '../effect/http.js';
import {
  runZatcaEffect,
  type ZatcaConnectionError,
  type ZatcaTimeoutError,
} from '../effect/errors.js';

const SANDBOX_URL = 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';
const PRODUCTION_URL = 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core-portal';

/** Resolves the API base URL for a configuration (pure helper, no I/O). */
const zatcaApiBaseUrl = (config: ZatcaApiConfig): string => {
  const defaultUrl =
    config.environment === 'production' ? PRODUCTION_URL : SANDBOX_URL;
  return config.sandboxUrl || config.productionUrl || defaultUrl;
};

export interface ZatcaRequestInput {
  baseUrl: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  credentials?: ZatcaCredentials;
  extraHeaders?: Record<string, string>;
  otp?: string;
}

/** Builds the full transport descriptor (URL + auth headers + JSON body). */
export const buildZatcaRequest = (input: ZatcaRequestInput): ZatcaHttpRequest => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': 'en',
    'Accept-Version': 'V2',
    ...input.extraHeaders,
  };

  if (input.otp) {
    headers['OTP'] = input.otp;
  } else if (input.credentials) {
    const auth = Buffer.from(
      `${input.credentials.binarySecurityToken}:${input.credentials.secret}`,
    ).toString('base64');
    headers['Authorization'] = `Basic ${auth}`;
  }

  return {
    method: input.method,
    url: `${input.baseUrl}${input.path}`,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  };
};

// ---- Effect twin ----

/** Effect twin of `ZatcaHttpClient.request`. */
export const requestEffect = (
  req: ZatcaHttpRequest,
): Effect.Effect<ZatcaHttpResponse, ZatcaConnectionError | ZatcaTimeoutError, ZatcaHttp> =>
  Effect.gen(function*() {
    const http = yield* ZatcaHttp;
    return yield* http.request(req);
  });

/** Runs `requestEffect` on the live `ZatcaHttp` layer, rethrowing `ZatcaError`. */
export const runZatcaRequest = (
  req: ZatcaHttpRequest,
  options: ZatcaHttpLayerOptions = {},
): Promise<ZatcaHttpResponse> =>
  runZatcaEffect(Effect.provide(requestEffect(req), layerZatcaHttp(options)));

export class ZatcaHttpClient {
  protected readonly baseUrl: string;
  protected readonly timeout: number;
  private readonly clearanceStatus: string;

  constructor(config: ZatcaApiConfig) {
    this.baseUrl = zatcaApiBaseUrl(config);
    this.timeout = config.timeout ?? 30000;
    this.clearanceStatus = config.clearanceStatus ?? '1';
  }

  /**
   * Legacy promise API (unchanged signature/behavior): performs the request
   * through the Effect `ZatcaHttp` workflow and keeps throwing `ZatcaError`
   * on connection failure and timeout.
   */
  protected async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    credentials?: ZatcaCredentials,
    extraHeaders?: Record<string, string>,
    otp?: string,
  ): Promise<ZatcaHttpResponse> {
    const descriptor = buildZatcaRequest({
      baseUrl: this.baseUrl,
      method,
      path,
      body,
      credentials,
      extraHeaders,
      otp,
    });
    return runZatcaRequest(descriptor, { timeoutMs: this.timeout });
  }

  protected getClearanceStatus(): string {
    return this.clearanceStatus;
  }
}

export type { ZatcaHttpRequest, ZatcaHttpResponse };
