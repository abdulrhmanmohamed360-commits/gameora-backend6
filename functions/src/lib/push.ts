import * as admin from "firebase-admin";
import { db } from "../firebase";

/*
 * =========================================================
 * Push Notifications (FCM)
 *
 * ملحوظة مهمة: الدالة دي بتتنادى بعد ما الـ Firestore
 * transaction بتاعة الطلب تخلص وتنجح، مش من جواها - عشان
 * قراءة الـ fcmTokens مش لازم تدخل في قواعد "كل القراءات
 * قبل الكتابات" بتاعة الـ transaction، ولو الـ push فشل
 * لأي سبب (توكن قديم، مفيش اتصال بـ FCM...) العملية
 * الأساسية (approve/deliver/confirm/...) متتأثرش خالص.
 * =========================================================
 */

export interface PushItem {
  userId: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export async function sendPushToUser(
  userId: string | undefined | null,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<void> {
  if (!userId) {
    return;
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return;
    }

    const tokens: string[] = Array.isArray(userDoc.data()?.fcmTokens)
      ? userDoc.data()!.fcmTokens
      : [];

    if (tokens.length === 0) {
      return;
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
      android: {
        priority: "high",
      },
    });

    /*
     * أي token بقى غير صالح (اتشال التطبيق من الجهاز مثلًا)
     * بنشيله من قاعدة البيانات عشان مايتكررش المحاولة عليه.
     */
    const invalidTokens: string[] = [];

    response.responses.forEach((r, i) => {
      const code = r.error?.code;

      if (
        !r.success &&
        (code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token")
      ) {
        invalidTokens.push(tokens[i]);
      }
    });

    if (invalidTokens.length > 0) {
      await db
        .collection("users")
        .doc(userId)
        .update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(
            ...invalidTokens
          ),
        });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("sendPushToUser failed for user", userId, err);
  }
}

export async function sendPushBatch(items: PushItem[]): Promise<void> {
  for (const item of items) {
    await sendPushToUser(item.userId, item.title, item.body, item.data);
  }
}
