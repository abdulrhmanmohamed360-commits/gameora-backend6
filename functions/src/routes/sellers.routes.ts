import { Router } from "express";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { toReviewDto } from "./reviews.routes";

const router = Router();

function toSellerDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    username: d.username ?? null,
    displayName: d.displayName ?? null,
    avatarUrl: d.avatarUrl ?? null,
    rating: d.rating ?? 0,
    reviewsCount: d.reviewsCount ?? 0,
    verified: d.verified ?? false,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

// GET /sellers/:id
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("users").doc(req.params.id).get();
    if (!doc.exists) throw Errors.notFound("Seller");
    res.json(toSellerDto(doc.id, doc.data()!));
  } catch (err) {
    next(err);
  }
});

// GET /sellers/:id/reviews
router.get("/:id/reviews", async (req, res, next) => {
  try {
    const snap = await db
      .collection("reviews")
      .where("sellerId", "==", req.params.id)
      .orderBy("createdAt", "desc")
      .get();
    res.json(snap.docs.map((d) => toReviewDto(d.id, d.data())));
  } catch (err) {
    next(err);
  }
});

export default router;
