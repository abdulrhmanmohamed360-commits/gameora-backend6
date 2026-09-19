import { NextFunction, Request, Response } from "express";
import * as admin from "firebase-admin";
import { Errors } from "../lib/errors";

// بيضيف Firebase UID على الـ Request بعد التحقق من Firebase ID Token
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const header = req.header("Authorization") || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : null;

  if (!token) {
    return next(Errors.unauthorized("Missing bearer token"));
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);

    req.userId = decodedToken.uid;
    next();
  } catch {
    return next(Errors.unauthorized("Invalid or expired token"));
  }
}

export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const header = req.header("Authorization") || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : null;

  if (token) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.userId = decodedToken.uid;
    } catch {
      // Optional auth: continue as a guest if the token is invalid.
    }
  }

  next();
}
