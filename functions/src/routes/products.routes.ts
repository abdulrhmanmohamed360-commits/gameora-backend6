import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";
import { toReviewDto } from "./reviews.routes";

const router = Router();

function toProductDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    gameId: d.gameId ?? null,
    title: d.title,
    description: d.description ?? null,
    price: d.price ?? 0,
    currency: d.currency ?? "USD",
    images: d.images ?? [],
    level: d.level ?? null,
    rank: d.rank ?? null,
    server: d.server ?? null,
    categoryId: d.categoryId ?? null,
    sellerId: d.sellerId ?? null,
    status: d.status ?? "available",
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

/**
 * بيطبق الفلاتر ويرجع صفحة واحدة بالشكل اللي PaginatedDto متوقعه.
 * الفلاتر البسيطة (equality) بتتعمل في Firestore نفسه، وفلتر السعر والبحث
 * النصي بيتعملوا بعد الجلب (in-memory) عشان نتجنب تعقيد composite indexes
 * الكتير على مشروع صغير/متوسط الحجم.
 */
async function queryProducts(filters: Record<string, any>, forcedGameId?: string) {
  let q: FirebaseFirestore.Query = db.collection("products");

  const gameId = forcedGameId || filters.game || filters.gameId;
  if (gameId) q = q.where("gameId", "==", gameId);
  if (filters.category || filters.categoryId) {
    q = q.where("categoryId", "==", filters.category || filters.categoryId);
  }
  if (filters.rank) q = q.where("rank", "==", filters.rank);
  if (filters.level) q = q.where("level", "==", filters.level);
  if (filters.server) q = q.where("server", "==", filters.server);
  q = q.where("status", "==", filters.status || "available");

  const snap = await q.orderBy("createdAt", "desc").limit(500).get();
  let items = snap.docs.map((d) => toProductDto(d.id, d.data()));

  const min = filters.priceMin ? parseFloat(filters.priceMin) : undefined;
  const max = filters.priceMax ? parseFloat(filters.priceMax) : undefined;
  if (min !== undefined) items = items.filter((p) => p.price >= min);
  if (max !== undefined) items = items.filter((p) => p.price <= max);

  if (filters.search) {
    const term = String(filters.search).toLowerCase();
    items = items.filter(
      (p) =>
        p.title.toLowerCase().includes(term) ||
        (p.description || "").toLowerCase().includes(term)
    );
  }

  const { page, limit } = parsePageParams(filters);
  const start = (page - 1) * limit;
  const pageItems = items.slice(start, start + limit);
  return buildPaginatedResponse(pageItems, items.length, page, limit);
}

// GET /products
router.get("/", async (req, res, next) => {
  try {
    res.json(await queryProducts(req.query as any));
  } catch (err) {
    next(err);
  }
});

// GET /products/:id
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("products").doc(req.params.id).get();
    if (!doc.exists) throw Errors.notFound("Product");
    res.json(toProductDto(doc.id, doc.data()!));
  } catch (err) {
    next(err);
  }
});

// GET /products/:id/reviews
router.get("/:id/reviews", async (req, res, next) => {
  try {
    const snap = await db
      .collection("reviews")
      .where("productId", "==", req.params.id)
      .orderBy("createdAt", "desc")
      .get();
    res.json(snap.docs.map((d) => toReviewDto(d.id, d.data())));
  } catch (err) {
    next(err);
  }
});

// POST /products (auth required — البائع بيحدده التوكن مش الجسم المرسل)
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { gameId, categoryId, title, description, price, currency, images, level, rank, server } =
      req.body || {};
    if (!gameId || !title || price === undefined || !currency) {
      throw Errors.badRequest("gameId, title, price and currency are required");
    }

    const now = new Date().toISOString();
    const id = uuid();
    const data = {
      gameId,
      categoryId: categoryId || null,
      sellerId: req.userId,
      title,
      description: description || null,
      price: Number(price),
      currency,
      images: images || [],
      level: level || null,
      rank: rank || null,
      server: server || null,
      status: "available",
      createdAt: now,
      updatedAt: now,
    };
    await db.collection("products").doc(id).set(data);
    res.status(201).json(toProductDto(id, data));
  } catch (err) {
    next(err);
  }
});

// PATCH /products/:id (لازم يكون البائع صاحب المنتج)
router.patch("/:id", requireAuth, async (req, res, next) => {
  try {
    const ref = db.collection("products").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) throw Errors.notFound("Product");
    if (doc.data()!.sellerId !== req.userId) throw Errors.forbidden("Not your product");

    const allowed = [
      "title",
      "description",
      "price",
      "currency",
      "images",
      "level",
      "rank",
      "server",
      "status",
    ];
    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body && req.body[key] !== undefined) updates[key] = req.body[key];
    }
    await ref.update(updates);
    const updated = await ref.get();
    res.json(toProductDto(updated.id, updated.data()!));
  } catch (err) {
    next(err);
  }
});

// DELETE /products/:id (لازم يكون البائع صاحب المنتج)
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const ref = db.collection("products").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) throw Errors.notFound("Product");
    if (doc.data()!.sellerId !== req.userId) throw Errors.forbidden("Not your product");
    await ref.delete();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
export { toProductDto, queryProducts };
