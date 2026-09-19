/*
 * =========================================================
 * الأدوار والصلاحيات (RBAC) الخاصة بلوحة الأدمن
 *
 * مصدر الحقيقة الوحيد للدور هو الحقل `role` داخل مستند
 * users/{uid} في Firestore. الحقل ده بيتكتب من الـ Backend فقط
 * (Admin SDK) — مفيش أي endpoint بيقبله من العميل، وقواعد
 * Firestore بتمنع أي كتابة من التطبيق.
 * =========================================================
 */

export type StaffRole = "admin" | "support";

export const STAFF_ROLES: StaffRole[] = ["admin", "support"];

export type Permission =
  | "stats.view"
  | "complaints.read"
  | "complaints.reply"
  | "complaints.manage"
  | "users.read"
  | "users.manage"
  | "roles.manage"
  | "products.read"
  | "products.manage"
  | "orders.read"
  | "wallet.read"
  | "conversations.read"
  | "offers.manage";

const ALL_PERMISSIONS: Permission[] = [
  "stats.view",
  "complaints.read",
  "complaints.reply",
  "complaints.manage",
  "users.read",
  "users.manage",
  "roles.manage",
  "products.read",
  "products.manage",
  "orders.read",
  "wallet.read",
  "conversations.read",
  "offers.manage",
];

/* فريق الدعم: يقدر يشتغل على الشكاوى فقط. أي بيانات إدارية تانية للأدمن فقط. */
const SUPPORT_PERMISSIONS: Permission[] = [
  "complaints.read",
  "complaints.reply",
  "complaints.manage",
];

export function isStaffRole(value: unknown): value is StaffRole {
  return value === "admin" || value === "support";
}

export function permissionsFor(role: StaffRole): Permission[] {
  return role === "admin" ? [...ALL_PERMISSIONS] : [...SUPPORT_PERMISSIONS];
}

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}
