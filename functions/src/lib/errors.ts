export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const Errors = {
  notFound: (what = "Resource") => new ApiError(404, "not_found", `${what} not found`),
  unauthorized: (msg = "Unauthorized") => new ApiError(401, "unauthorized", msg),
  forbidden: (msg = "Forbidden") => new ApiError(403, "forbidden", msg),
  badRequest: (msg = "Bad request") => new ApiError(400, "bad_request", msg),
  conflict: (msg = "Conflict") => new ApiError(409, "conflict", msg),
  insufficientBalance: () =>
    new ApiError(402, "insufficient_balance", "Insufficient wallet balance"),
};
