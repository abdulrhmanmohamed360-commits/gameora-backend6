import { NextFunction, Request, Response } from "express";
import * as admin from "firebase-admin";
import { Errors } from "../lib/errors";
import {
  hasPermission,
  isStaffRole,
  type Permission,
  type StaffRole,
} from "../lib/permissions";

// بيضيف Firebase UID على الـ Request بعد التحقق من Firebase ID Token
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      staff?: StaffContext;
    }
  }
}

export interface StaffContext {
  uid: string;
  name: string;
  role: StaffRole;
}

/**
 * التحقق من Firebase ID Token فقط.
 */
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

/**
 * Auth اختياري.
 */
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

/**
 * التحقق أن المستخدم Staff من خلال users/{uid}.role
 *
 * الدور لا يأتي من العميل ولا من الـ body أو headers.
 */
export async function requireStaff(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  await requireAuth(req, _res, async (err?: any) => {
    if (err) {
      return next(err);
    }

    try {
      const uid = req.userId!;

      const snapshot = await admin
        .firestore()
        .collection("users")
        .doc(uid)
        .get();

      if (!snapshot.exists) {
        return next(Errors.forbidden("Staff access required"));
      }

      const data = snapshot.data() || {};
      const role = data.role;

      if (!isStaffRole(role)) {
        return next(Errors.forbidden("Staff access required"));
      }

      const name = String(
        data.displayName ||
          data.username ||
          data.email ||
          "Gameora Staff"
      );

      req.staff = {
        uid,
        name,
        role,
      };

      next();
    } catch {
      return next(Errors.forbidden("Unable to verify staff permissions"));
    }
  });
}

/**
 * حماية مسار حسب صلاحية محددة.
 */
export function requirePermission(permission: Permission) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    await requireStaff(req, res, (err?: any) => {
      if (err) {
        return next(err);
      }

      const staff = req.staff;

      if (!staff || !hasPermission(staff.role, permission)) {
        return next(Errors.forbidden("Insufficient permissions"));
      }

      next();
    });
  };
}
