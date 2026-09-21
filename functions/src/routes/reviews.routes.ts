import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

const router = Router();

function toReviewDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    productId: d.productId ?? null,
    sellerId: d.sellerId ?? null,
    authorName: d.authorName ?? null,
    authorAvatarUrl: d.authorAvatarUrl ?? null,
    rating: d.rating ?? 0,
    comment: d.comment ?? null,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

// POST /reviews (auth required)
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { productId, sellerId, rating, comment } = req.body || {};
    if (!rating || !comment || (!productId && !sellerId)) {
      throw Errors.badRequest("rating, comment and (productId or sellerId) are required");
    }
    if (rating < 1 || rating > 5) throw Errors.badRequest("rating must be between 1 and 5");

    const authorDoc = await db.collection("users").doc(req.userId!).get();
    const author = authorDoc.data();

    const now = new Date().toISOString();
    const id = uuid();
    const data = {
      productId: productId || null,
      sellerId: sellerId || null,
      authorId: req.userId,
      authorName: author?.displayName || author?.username || "User",
      authorAvatarUrl: author?.avatarUrl || null,
      rating: Number(rating),
      comment,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection("reviews").doc(id).set(data);

    // بيحدّث متوسط تقييم البائع لو المراجعة على بائع
    if (sellerId) {
      const sellerRef = db.collection("users").doc(sellerId);
      await db.runTransaction(async (tx) => {
        const sellerDoc = await tx.get(sellerRef);
        if (!sellerDoc.exists) return;
        const s = sellerDoc.data()!;
        const prevCount = s.reviewsCount || 0;
        const prevRating = s.rating || 0;
        const newCount = prevCount + 1;
        const newRating = (prevRating * prevCount + Number(rating)) / newCount;
        tx.update(sellerRef, {
          reviewsCount: newCount,
          rating: newRating,
          updatedAt: now,
        });
      });
    }

    res.status(201).json(toReviewDto(id, data));
  } catch (err) {
    next(err);
  }
});

export default router;
export { toReviewDto };
