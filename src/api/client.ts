/**
 * ZATCA Fatoora API HTTP Client
 *
 * Low-level HTTP wrapper for all ZATCA API communication.
 * Handles authentication headers, timeouts, and error wrapping.
 */

import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type {
  ZatcaEnvironment,
  ZatcaApiConfig,
  ZatcaCredentials,
} from '../types.js';

const SANDBOX_URL = 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal';
const PRODUCTION_URL = 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core-portal';

export class ZatcaHttpClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly clearanceStatus: string;

  constructor(config: ZatcaApiConfig) {
    const defaultUrl =
      config.environment === 'production' ? PRODUCTION_URL : SANDBOX_URL;
    this.baseUrl = config.sandboxUrl || config.productionUrl || defaultUrl;
    this.timeout = config.timeout ?? 30000;
    this.clearanceStatus = config.clearanceStatus ?? '1';
  }

  protected async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    credentials?: ZatcaCredentials,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'en',
      'Accept-Version': 'V2',
      ...extraHeaders,
    };

    if (credentials) {
      const auth = Buffer.from(
        `${credentials.binarySecurityToken}:${credentials.secret}`,
      ).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const responseBody = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return { status: response.status, body: responseBody, headers: responseHeaders };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new ZatcaError(
          `ZATCA API request timed out after ${this.timeout}ms`,
          ZatcaErrorCode.API_TIMEOUT,
        );
      }
      throw new ZatcaError(
        `ZATCA API connection failed: ${(error as Error).message}`,
        ZatcaErrorCode.API_CONNECTION_ERROR,
        error,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  protected getClearanceStatus(): string {
    return this.clearanceStatus;
  }
}
