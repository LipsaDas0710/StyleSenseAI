import { ZodError } from 'zod';

export class AppError extends Error {
  status;
  code;
  details;

  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what, id) =>
  new AppError(404, 'NOT_FOUND', id === undefined ? `${what} not found` : `${what} ${id} not found`);

const isPgError = (e) =>
  typeof e === 'object' && e !== null && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code);

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      400,
      'VALIDATION_ERROR',
      'The request contains invalid fields',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (typeof err === 'object' && err !== null && err.type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (isPgError(err)) {
    // Constraint violations that slipped past request validation are still the client's fault.
    switch (err.code) {
      case '23505':
        return new AppError(409, 'CONFLICT', 'A record with these values already exists', {
          constraint: err.constraint,
        });
      case '23503':
        return new AppError(409, 'REFERENCE_ERROR', 'A referenced record does not exist or is still in use', {
          constraint: err.constraint,
        });
      case '23514':
      case '23502':
      case '22P02':
        return new AppError(400, 'VALIDATION_ERROR', 'A field value violates a database constraint', {
          constraint: err.constraint,
        });
    }
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
}

export const errorHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  if (appError.status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  });
};

export const routeNotFound = (req, _res, next) =>
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
