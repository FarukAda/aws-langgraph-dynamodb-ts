/**
 * Capture structured logger output for .toMatchObject assertions on retry /
 * catch paths (REQ-23 / NFR-6 / gap K / AC-19).
 *
 * Uses the package's setGlobalLogger / resetLogger seam (public API) to install
 * a recording logger. The recorded entries expose the exact field names the
 * production logger contract emits so ops alerting cannot silently break on a
 * rename.
 */
import { resetLogger, setGlobalLogger, type Logger } from '../../../src/index';

export interface CapturedEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: unknown;
}

export interface LoggerCapture {
  logger: Logger;
  entries: CapturedEntry[];
  restore: () => void;
}

/**
 * Install a recording logger globally and return the captured entries plus a
 * restore() that resets the global logger back to default.
 */
export function captureLogger(): LoggerCapture {
  const entries: CapturedEntry[] = [];
  const record =
    (level: CapturedEntry['level']) =>
    (message: string, meta?: unknown): void => {
      entries.push({ level, message, meta });
    };

  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as Logger; // shape adapter for the production Logger interface

  setGlobalLogger(logger);

  return {
    logger,
    entries,
    restore: () => resetLogger(),
  };
}

/**
 * Assert at least one captured entry at `level` matches `matcher` via
 * toMatchObject (so callers assert the documented fields without pinning the
 * whole structure).
 */
export function expectLogFields(
  entries: CapturedEntry[],
  level: CapturedEntry['level'],
  matcher: Record<string, unknown>,
): void {
  const atLevel = entries.filter((e) => e.level === level);
  expect(atLevel.length).toBeGreaterThan(0);
  const merged = atLevel.map((e) => ({ message: e.message, ...(e.meta as object) }));
  expect(merged).toEqual(expect.arrayContaining([expect.objectContaining(matcher)]));
}
