import * as admin from "firebase-admin";

// على Render (سيرفر عادي، مش Firebase Functions) لازم نديله الـ credentials
// بنفسنا من متغير بيئة اسمه GOOGLE_SERVICE_ACCOUNT_JSON (نفس محتوى ملف الـ
// service account json اللي نزلته من Firebase Console، ملصوق كامل كـ نص واحد).
if (admin.apps.length === 0) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable. " +
        "Paste the full Firebase service-account JSON as this env var's value."
    );
  }
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
