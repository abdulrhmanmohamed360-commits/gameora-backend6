import { Errors } from "./errors";

/*
 * مفتاح الإدارة (نفس المتغير والقيمة الافتراضية المستخدمين في admin.routes.ts).
 * كل مسارات /admin/* الجديدة بتعدّي من هنا؛ الصلاحيات كلها Server-side.
 */
const ADMIN_KEY = process.env.ADMIN_SEED_KEY || "dev-only-change-me";

export function checkAdminKey(req: any): void {
  const key = req.header("x-admin-key") || req.query.key;

  if (!key || key !== ADMIN_KEY) {
    throw Errors.unauthorized("Invalid admin key");
  }
}
