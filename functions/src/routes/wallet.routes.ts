import { Router } from "express";
import { db } from "../firebase";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";

const router = Router();
router.use(requireAuth);

function toTransactionDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    type: d.type ?? null,
    amount: d.amount ?? 0,
    currency: d.currency ?? "USD",
    description: d.description ?? null,
    status: d.status ?? null,
    createdAt: d.createdAt ?? null,
  };
}

// GET /wallet
router.get("/", async (req, res, next) => {
  try {
    const doc = await db.collection("wallets").doc(req.userId!).get();
    const d = doc.exists ? doc.data()! : { balance: 0, currency: "USD", pendingBalance: 0 };
    res.json({
      balance: d.balance ?? 0,
      currency: d.currency ?? "USD",
      pendingBalance: d.pendingBalance ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /wallet/transactions
router.get("/transactions", async (req, res, next) => {
  try {
    const snap = await db
      .collection("transactions")
      .where("userId", "==", req.userId)
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();
    const items = snap.docs.map((d) => toTransactionDto(d.id, d.data()));

    const { page, limit } = parsePageParams(req.query as any);
    const start = (page - 1) * limit;
    res.json(buildPaginatedResponse(items.slice(start, start + limit), items.length, page, limit));
  } catch (err) {
    next(err);
  }
});

export default router;
