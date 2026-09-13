/**
 * Parser for the official ZATCA E-Invoicing Java SDK 3.0.8 CLI `-validate`
 * output. The format was established by REVERSE-ENGINEERING (running the CLI
 * on known-good and deliberately-broken invoices) — see
 * parse-validation-report.test.ts for verbatim captured samples that pin the
 * behavior. Do not "fix" the parser against assumptions; re-capture real
 * output if the SDK version changes.
 *
 * Format facts (SDK 3.0.8, observed):
 *
 *   2026-09-13 22:41:24,814 [INFO] ValidationProcessorImpl - [XSD] validation result : PASSED
 *   2026-09-13 22:41:25,502 [ERROR] ValidationProcessorImpl - qr validation errors :
 *   2026-09-13 22:41:25,503 [ERROR] ValidationProcessorImpl - CODE : R, MESSAGE : R value ...
 *   2026-09-13 22:41:25,503 [INFO] InvoiceValidationService -  *** GLOBAL VALIDATION RESULT = FAILED
 *
 * - log4j lines: `YYYY-MM-DD HH:MM:SS,mmm [LEVEL] Logger - message`.
 *   The welcome banner is printed via an `[ERROR] MainApp -` line and consists
 *   of untimestamped lines — they must never be parsed as findings.
 * - stage result lines: `[STAGE] validation result : PASSED|FAILED`
 *   (observed stages: XSD, EN, KSA, QR; the binary also knows SIGNATURE/PIH).
 * - per-stage error blocks: `<stage> validation errors : ` header followed by
 *   `CODE : <code>, MESSAGE : <message>` lines (one per finding, single line).
 * - schematron warnings are folded into the same `ksa validation errors`
 *   block by the CLI (BR-KSA-09 is flag="warning" upstream yet still prints
 *   there) — there is no warnings channel; `warnings` captures `[WARN]`
 *   log lines only.
 * - summary: `*** GLOBAL VALIDATION RESULT = PASSED|FAILED`.
 * - WITHOUT a valid SDK_CONFIG the CLI crashes before validating, prints
 *   `failed to validate invoice - <cause>` and STILL EXITS 0 — surfaced as
 *   `crashed` so harnesses can distinguish "valid" from "never ran".
 */
export interface ParsedValidationReport {
  /** XSD (structural) errors — entries formatted `CODE : MESSAGE`. */
  xsdErrors: string[];
  /** EN16931 + ZATCA(KSA) schematron failed-asserts — `CODE : MESSAGE`. */
  schematronErrors: string[];
  /** `[WARN]`-level log lines (SDK 3.0.8 emits none in practice). */
  warnings: string[];
  /** Errors from later cryptographic stages (QR, SIGNATURE, PIH), if reached. */
  otherErrors: string[];
  /** `'PASSED' | 'FAILED'` per observed stage, e.g. `{ XSD: 'PASSED', KSA: 'FAILED' }`. */
  stageResults: Record<string, 'PASSED' | 'FAILED'>;
  /** Final `*** GLOBAL VALIDATION RESULT` value; undefined when never reached. */
  summary?: 'PASSED' | 'FAILED';
  /** True when the CLI aborted before validating (e.g. broken SDK config). */
  crashed: boolean;
}

/** A log4j-style line: `<ts> [LEVEL] <logger> - <message>` (ts optional). */
const LOG_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} )?\[([A-Z]+)\] ([\w.$]+) - ?(.*)$/;

const STAGE_RESULT = /\[([A-Z]+)\] validation result : (PASSED|FAILED)\s*$/;
const STAGE_ERROR_HEADER = /^(xsd|en|ksa|qr|signature|pih) validation errors : ?$/i;
const CODE_MESSAGE = /^CODE : (.*?), MESSAGE : (.*)$/;
const SUMMARY = /GLOBAL VALIDATION RESULT = (PASSED|FAILED)/;
const CRASH = /failed to validate invoice(?: - (.*))?$/;

/** Stage name (lowercase, as used in the error-block header) → bucket. */
function bucketForStage(stage: string): 'xsd' | 'schematron' | 'other' {
  const s = stage.toLowerCase();
  if (s === 'xsd') return 'xsd';
  if (s === 'en' || s === 'ksa') return 'schematron';
  return 'other';
}

/**
 * Parse combined CLI output of `fatoora -validate`.
 *
 * @param stdout CLI stdout (the SDK prints everything there, banner included)
 * @param stderr CLI stderr (checked for `[WARN]` lines; empty in practice)
 */
export function parseValidationReport(stdout: string, stderr = ''): ParsedValidationReport {
  const report: ParsedValidationReport = {
    xsdErrors: [],
    schematronErrors: [],
    warnings: [],
    otherErrors: [],
    stageResults: {},
    crashed: false,
  };

  // Bucket the error-block header currently in effect; '' = not in a block.
  let currentBucket: 'xsd' | 'schematron' | 'other' | '' = '';

  for (const line of stdout.split('\n')) {
    const log = LOG_LINE.exec(line);

    if (!log) continue; // banner / blank / continuation noise — never a finding

    const [, , level, , message] = log;

    const stageResult = STAGE_RESULT.exec(message);
    if (stageResult) {
      const [, stage, result] = stageResult;
      report.stageResults[stage] = result as 'PASSED' | 'FAILED';
      currentBucket = '';
      continue;
    }

    const errorHeader = STAGE_ERROR_HEADER.exec(message);
    if (errorHeader) {
      currentBucket = bucketForStage(errorHeader[1]);
      continue;
    }

    if (SUMMARY.test(message)) {
      report.summary = SUMMARY.exec(message)![1] as 'PASSED' | 'FAILED';
      currentBucket = '';
      continue;
    }

    const crash = CRASH.exec(message);
    if (crash && level === 'ERROR') {
      report.crashed = true;
      currentBucket = '';
      continue;
    }

    const codeMessage = CODE_MESSAGE.exec(message);
    if (codeMessage && currentBucket !== '') {
      const entry = `${codeMessage[1]} : ${codeMessage[2]}`;
      if (currentBucket === 'xsd') report.xsdErrors.push(entry);
      else if (currentBucket === 'schematron') report.schematronErrors.push(entry);
      else report.otherErrors.push(entry);
      continue;
    }

    if (level === 'WARN') report.warnings.push(message);
  }

  // stderr may carry JVM/log warnings; never findings.
  for (const line of stderr.split('\n')) {
    const log = LOG_LINE.exec(line);
    if (log && log[2] === 'WARN') report.warnings.push(log[4]);
  }

  // A run that never reached the summary never validated anything.
  if (report.summary === undefined && !report.crashed) report.crashed = true;

  return report;
}
