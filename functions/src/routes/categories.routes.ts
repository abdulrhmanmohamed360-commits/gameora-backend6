import { Router } from "express";
import { db } from "../firebase";
import { Errors } from "../lib/errors";

const router = Router();

function toCategoryDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    name: d.name,
    description: d.description ?? null,
    iconUrl: d.iconUrl ?? null,
    imageUrl: d.imageUrl ?? null,
    status: d.status ?? "active",
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

// GET /categories
router.get("/", async (_req, res, next) => {
  try {
    const snap = await db.collection("categories").orderBy("createdAt", "desc").get();
    res.json(snap.docs.map((d) => toCategoryDto(d.id, d.data())));
  } catch (err) {
    next(err);
  }
});

// GET /categories/:id
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("categories").doc(req.params.id).get();
    if (!doc.exists) throw Errors.notFound("Category");
    res.json(toCategoryDto(doc.id, doc.data()!));
  } catch (err) {
    next(err);
  }
});

export default router;
