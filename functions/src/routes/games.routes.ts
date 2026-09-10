import { Router } from "express";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { queryProducts } from "./products.routes";

const router = Router();

function toGameDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    name: d.name,
    description: d.description ?? null,
    imageUrl: d.imageUrl ?? null,
    iconUrl: d.iconUrl ?? null,
    bannerUrl: d.bannerUrl ?? null,
    status: d.status ?? "active",
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

// GET /games
router.get("/", async (_req, res, next) => {
  try {
    const snap = await db.collection("games").orderBy("createdAt", "desc").get();
    res.json(snap.docs.map((d) => toGameDto(d.id, d.data())));
  } catch (err) {
    next(err);
  }
});

// GET /games/:id
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("games").doc(req.params.id).get();
    if (!doc.exists) throw Errors.notFound("Game");
    res.json(toGameDto(doc.id, doc.data()!));
  } catch (err) {
    next(err);
  }
});

// GET /games/:gameId/products
router.get("/:gameId/products", async (req, res, next) => {
  try {
    res.json(await queryProducts(req.query as any, req.params.gameId));
  } catch (err) {
    next(err);
  }
});

export default router;
export { toGameDto };
