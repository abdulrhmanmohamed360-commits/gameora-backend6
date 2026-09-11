import { Router } from "express";
import { db } from "../firebase";

const router = Router();

/* =========================================================
   GET /offers
   العروض النشطة التي يمكن للتطبيق عرضها
   ========================================================= */

router.get("/", async (_req, res, next) => {
  try {
    const now = new Date().toISOString();

    // نقرأ العروض من Firestore بدون where
    // ثم نتحقق من الحالة والتاريخ داخل السيرفر
    const snapshot = await db
      .collection("offers")
      .get();

    const offers = snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .filter((offer: any) => {

        // العرض لازم يكون فعال
        if (offer.status !== "active") {
          return false;
        }

        // لو العرض له تاريخ بداية
        if (
          offer.startAt &&
          String(offer.startAt) > now
        ) {
          return false;
        }

        // لو العرض له تاريخ انتهاء
        if (
          offer.endAt &&
          String(offer.endAt) < now
        ) {
          return false;
        }

        return true;
      });

    // الأحدث أولاً
    offers.sort((a: any, b: any) => {
      const aDate = String(a.createdAt || "");
      const bDate = String(b.createdAt || "");

      return bDate.localeCompare(aDate);
    });

    return res.json({
      ok: true,
      offers,
    });

  } catch (err) {
    console.error("GET /offers error:", err);

    next(err);
  }
});

export default router;
