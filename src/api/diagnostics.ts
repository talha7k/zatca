import { ZatcaError, ZatcaErrorCode } from '../errors.js';
import type {
  ZatcaApiError,
  ZatcaApiWarning,
  ZatcaSubmissionAlert,
  ZatcaSubmitResult,
} from '../types.js';

type ValidationMessage = {
  code?: string;
  category?: string;
  message?: string;
};

type ValidationResults = {
  errorMessages?: ValidationMessage[];
  warningMessages?: ValidationMessage[];
};

export function normalizeApiError(message: ValidationMessage): ZatcaApiError {
  return {
    code: message.code || 'ZATCA_VALIDATION_ERROR',
    category: message.category || 'ZATCA',
    message: message.message || 'ZATCA rejected the submitted document',
  };
}

export function normalizeApiWarning(message: ValidationMessage): ZatcaApiWarning {
  return {
    code: message.code || 'ZATCA_WARNING',
    category: message.category || 'ZATCA',
    message: message.message || 'ZATCA returned a warning for the submitted document',
  };
}

export function extractValidationDiagnostics(
  validationResults?: ValidationResults,
): {
  error?: ZatcaApiError;
  warnings: ZatcaApiWarning[];
  alerts: ZatcaSubmissionAlert[];
} {
  const errors = (validationResults?.errorMessages || []).map(normalizeApiError);
  const warnings = (validationResults?.warningMessages || []).map(normalizeApiWarning);
  const alerts: ZatcaSubmissionAlert[] = [
    ...errors.map((error) => ({
      severity: 'error' as const,
      code: error.code,
      category: error.category,
      message: error.message,
    })),
    ...warnings.map((warning) => ({
      severity: 'warning' as const,
      code: warning.code,
      category: warning.category,
      message: warning.message,
    })),
  ];

  return {
    error:
      errors.length > 0
        ? {
            code: errors.map((error) => error.code).join(','),
            category: errors.map((error) => error.category).join(','),
            message: errors.map((error) => `${error.code}: ${error.message}`).join('; '),
          }
        : undefined,
    warnings,
    alerts,
  };
}

export function assertNoZatcaAlerts(result: ZatcaSubmitResult, operation: string): void {
  if (result.success && (!result.alerts || result.alerts.length === 0)) {
    return;
  }

  const alerts = result.alerts || [];
  const diagnostics =
    alerts.length > 0
      ? alerts
          .map((alert) => `${alert.severity.toUpperCase()} ${alert.code}: ${alert.message}`)
          .join('; ')
      : result.error?.message || `HTTP ${result.httpStatus}`;

  throw new ZatcaError(
    `${operation} failed: ${diagnostics}`,
    ZatcaErrorCode.API_ERROR,
    {
      httpStatus: result.httpStatus,
      error: result.error,
      alerts,
      rawBody: result.rawBody,
    },
  );
}
