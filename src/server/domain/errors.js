import { ERROR_CODE } from './constants.js';

/**
 * Application error carrying an HTTP status, a stable machine code and
 * optional field-level details. Route handlers translate these into
 * responses; stack traces and SQL text never reach a client.
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const validationError = (message, details = null) =>
  new AppError(ERROR_CODE.VALIDATION, message, { status: 422, details });

export const notFound = (message = 'Not found') =>
  new AppError(ERROR_CODE.NOT_FOUND, message, { status: 404 });

export const unauthorized = (message = 'Sign in required') =>
  new AppError(ERROR_CODE.UNAUTHORIZED, message, { status: 401 });

export const forbidden = (message = 'Not permitted') =>
  new AppError(ERROR_CODE.FORBIDDEN, message, { status: 403 });

export const conflict = (message) =>
  new AppError(ERROR_CODE.CONFLICT, message, { status: 409 });

export const rateLimited = (message = 'Too many requests. Please try again shortly.') =>
  new AppError(ERROR_CODE.RATE_LIMITED, message, { status: 429 });

/**
 * Thrown when a requested booking period is already consumed, or when the
 * database trigger rejects an overlapping occupancy row. `details.conflicts`
 * describes the blocking reservations/maintenance so the UI can explain why.
 */
export class DoubleBookingError extends AppError {
  constructor(message, conflicts = []) {
    super(ERROR_CODE.DOUBLE_BOOKING, message, {
      status: 409,
      details: { conflicts },
    });
    this.name = 'DoubleBookingError';
    this.conflicts = conflicts;
  }
}
