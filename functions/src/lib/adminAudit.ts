import { v4 as uuid } from "uuid";
import { db } from "../firebase";

/*
 * سجل تدقيق (Audit Log) لكل إجراء إداري حساس: تجميد، استرجاع أموال،
 * تسليم أموال، مراسلة أطراف نزاع، إخفاء منتج...
 * فشل الكتابة هنا ما بيوقفش الإجراء الأساسي (بيتسجّل في الـ log بس).
 */
export async function logAdminAction(entry: {
  action: string;
  targetType: string;
  targetId: string;
  note?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db
      .collection("adminActions")
      .doc(uuid())
      .set({
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        note: entry.note ?? null,
        meta: entry.meta ?? {},
        createdAt: new Date().toISOString(),
      });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("logAdminAction failed", entry.action, err);
  }
}
