import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import type { StaffContext } from "../middleware/auth";

/*
 * أدوات مشتركة لمسارات الأدمن.
 */

/** تحويل التواريخ المختلفة إلى ISO string. */
export function toIso(v: any): string | null {
  if (v === null || v === undefined) return null;

  if (typeof v === "string") {
    return v;
  }

  if (v instanceof Date) {
    return v.toISOString();
  }

  if (typeof v.toDate === "function") {
    try {
      return v.toDate().toISOString();
    } catch {
      return null;
    }
  }

  return null;
}

/** query-string → نص نظيف أو undefined. */
export function qs(v: unknown): string | undefined {
  return typeof v === "string" && v.trim()
    ? v.trim()
    : undefined;
}

/** تحويل مجموعة user IDs إلى أسماء عرض. */
export async function userNames(
  ids: Array<string | null | undefined>
): Promise<Record<string, string>> {
  const unique = Array.from(
    new Set(
      ids.filter(
        (v): v is string =>
          typeof v === "string" && v.length > 0
      )
    )
  );

  const out: Record<string, string> = {};

  for (let i = 0; i < unique.length; i += 100) {
    const refs = unique
      .slice(i, i + 100)
      .map((id) => db.collection("users").doc(id));

    const snaps = await db.getAll(...refs);

    snaps.forEach((snap) => {
      if (!snap.exists) return;

      const data = snap.data()!;

      out[snap.id] = String(
        data.displayName ||
          data.username ||
          data.email ||
          snap.id
      );
    });
  }

  return out;
}

/**
 * تسجيل عمليات الأدمن الحساسة.
 */
export async function audit(
  staff: StaffContext,
  action: string,
  target: {
    type: string;
    id?: string | null;
  },
  meta: Record<string, any> = {}
): Promise<void> {
  await db
    .collection("adminAuditLogs")
    .doc(uuid())
    .set({
      adminId: staff.uid,
      adminName: staff.name,
      role: staff.role,
      action,
      targetType: target.type,
      targetId: target.id ?? null,
      meta,
      createdAt: new Date().toISOString(),
    });
}

/** ترتيب العناصر من الأحدث إلى الأقدم. */
export function sortByDateDesc<T>(
  items: T[],
  pick: (item: T) => string | null
): T[] {
  return [...items].sort((a, b) =>
    (pick(b) ?? "").localeCompare(pick(a) ?? "")
  );
  }
