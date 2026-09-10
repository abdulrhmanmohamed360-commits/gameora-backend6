import { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/jwt";
import { Errors } from "../lib/errors";

// بيضيف userId على الـ Request بعد التحقق من التوكن
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(Errors.unauthorized("Missing bearer token"));

  const payload = verifyToken(token);
  if (!payload) return next(Errors.unauthorized("Invalid or expired token"));

  req.userId = payload.uid;
  next();
}

// بيحاول ياخد الـ userId لو موجود من غير ما يرفض الطلب لو مفيش توكن
// (مفيدة لو حبيت تعمل endpoint شغال للزوار وللمسجلين مع اختلاف بسيط في الرد)
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.userId = payload.uid;
  }
  next();
}
