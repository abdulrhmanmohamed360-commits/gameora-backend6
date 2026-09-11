import { Router } from "express";
import { db } from "../firebase";

const router = Router();

// GET /offers
// إرجاع العروض النشطة التي يمكن للتطبيق عرضها
router.get("/", async (_req, res, next) => {
  try {
    const now = new Date().toISOString();

    const snapshot = await db
      .collection("offers")
      .where("status", "==", "active")
      .get();

    const offers = snapshot.docs
      .map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
      .filter((offer: any) => {
        if (offer.startAt && offer.startAt > now) return false;
        if (offer.endAt && offer.endAt < now) return false;
        return true;
      });

    offers.sort((a: any, b: any) => {
      const aDate = a.createdAt || "";
      const bDate = b.createdAt || "";
      return bDate.localeCompare(aDate);
    });

    res.json({
      ok: true,
      offers,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
