/**
 * Structured logging utility for Cloud Functions
 * Outputs JSON-formatted logs that are automatically captured by Cloud Logging
 */

export enum LogSeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

interface LogEntry {
  severity: LogSeverity;
  message: string;
  timestamp: string;
  [key: string]: any;
}

/**
 * Create a structured log entry
 */
function createLogEntry(
  severity: LogSeverity,
  message: string,
  metadata?: Record<string, any>
): string {
  const entry: LogEntry = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...metadata,
  };
  return JSON.stringify(entry);
}

/**
 * Log at DEBUG level
 */
export function logDebug(message: string, metadata?: Record<string, any>): void {
  console.log(createLogEntry(LogSeverity.DEBUG, message, metadata));
}

/**
 * Log at INFO level
 */
export function logInfo(message: string, metadata?: Record<string, any>): void {
  console.log(createLogEntry(LogSeverity.INFO, message, metadata));
}

/**
 * Log at WARNING level
 */
export function logWarning(message: string, metadata?: Record<string, any>): void {
  console.warn(createLogEntry(LogSeverity.WARNING, message, metadata));
}

/**
 * Log at ERROR level
 */
export function logError(
  message: string,
  error?: Error | unknown,
  metadata?: Record<string, any>
): void {
  const errorMetadata: Record<string, any> = {
    ...metadata,
  };

  if (error instanceof Error) {
    errorMetadata.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } else if (error) {
    errorMetadata.error = String(error);
  }

  console.error(createLogEntry(LogSeverity.ERROR, message, errorMetadata));
}

/**
 * Log at CRITICAL level
 */
export function logCritical(
  message: string,
  error?: Error | unknown,
  metadata?: Record<string, any>
): void {
  const errorMetadata: Record<string, any> = {
    ...metadata,
  };

  if (error instanceof Error) {
    errorMetadata.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } else if (error) {
    errorMetadata.error = String(error);
  }

  console.error(createLogEntry(LogSeverity.CRITICAL, message, errorMetadata));
}
