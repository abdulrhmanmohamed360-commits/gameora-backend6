import { Router } from "express";
import { db } from "../firebase";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";

const router = Router();
router.use(requireAuth);

function toNotificationDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    type: d.type ?? null,
    title: d.title ?? null,
    body: d.body ?? null,
    read: d.read ?? false,
    createdAt: d.createdAt ?? null,
  };
}

// GET /notifications
router.get("/", async (req, res, next) => {
  try {
    const snap = await db
      .collection("notifications")
      .where("userId", "==", req.userId)
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();
    const items = snap.docs.map((d) => toNotificationDto(d.id, d.data()));

    const { page, limit } = parsePageParams(req.query as any);
    const start = (page - 1) * limit;
    res.json(buildPaginatedResponse(items.slice(start, start + limit), items.length, page, limit));
  } catch (err) {
    next(err);
  }
});

export default router;
