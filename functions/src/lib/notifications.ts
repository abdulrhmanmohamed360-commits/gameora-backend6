import { v4 as uuid } from "uuid";
import { db } from "../firebase";

/*
 * =========================================================
 * In-app Notifications (مستقلة عن Push/FCM)
 *
 * بيكتب مستند في مجموعة "notifications" في Firestore، وده اللي
 * بيقرأه GET /notifications (شاشة جرس الإشعارات جوه التطبيق).
 * ده منفصل تمامًا عن sendPushToUser في lib/push.ts، اللي بيبعت
 * Push حقيقي (FCM) للجهاز - المفروض الاتنين يتنادوا مع بعض في
 * نفس الحدث (رسالة جديدة، رد دعم فني، تغيير حالة تذكرة...).
 * =========================================================
 */
export async function createNotification(
  userId: string | undefined | null,
  type: string,
  title: string,
  body: string,
  extra: { conversationId?: string | null } = {}
): Promise<void> {
  if (!userId) {
    return;
  }

  try {
    const now = new Date().toISOString();
    const id = uuid();

    await db.collection("notifications").doc(id).set({
      userId,
      type,
      title,
      body,
      read: false,
      createdAt: now,
      conversationId: extra.conversationId ?? null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("createNotification failed for user", userId, err);
  }
}
