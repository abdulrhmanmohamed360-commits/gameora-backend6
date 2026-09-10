import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";

const router = Router();
router.use(requireAuth);

function toOrderDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    status: d.status,
    items: d.items ?? [],
    total: d.total ?? 0,
    currency: d.currency ?? "USD",
    sellerId: d.sellerId ?? null,
    sellerName: d.sellerName ?? null,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

// GET /orders — أوردرات المستخدم الحالي (كـ buyer)
router.get("/", async (req, res, next) => {
  try {
    let q: FirebaseFirestore.Query = db.collection("orders").where("buyerId", "==", req.userId);
    if (req.query.status) q = q.where("status", "==", req.query.status);

    const snap = await q.orderBy("createdAt", "desc").limit(500).get();
    const items = snap.docs.map((d) => toOrderDto(d.id, d.data()));

    const { page, limit } = parsePageParams(req.query as any);
    const start = (page - 1) * limit;
    res.json(buildPaginatedResponse(items.slice(start, start + limit), items.length, page, limit));
  } catch (err) {
    next(err);
  }
});

// GET /orders/:id — لازم يكون المشتري أو البائع
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("orders").doc(req.params.id).get();
    if (!doc.exists) throw Errors.notFound("Order");
    const d = doc.data()!;
    if (d.buyerId !== req.userId && d.sellerId !== req.userId) {
      throw Errors.forbidden("Not your order");
    }
    res.json(toOrderDto(doc.id, d));
  } catch (err) {
    next(err);
  }
});

// POST /orders
// السيرفر (مش الأندرويد) هو اللي بيتحقق من توفر المنتج، وبيعيد حساب السعر من
// قاعدة البيانات، وبيتأكد من رصيد المشتري قبل ما ينشئ الأوردر — بالظبط زي ما
// الـ README بيطلب: "The app never trusts a client-side price."
router.post("/", async (req, res, next) => {
  try {
    const { productId, quantity } = req.body || {};
    if (!productId) throw Errors.badRequest("productId is required");
    const qty = Math.max(1, Number(quantity) || 1);

    const productRef = db.collection("products").doc(productId);
    const buyerWalletRef = db.collection("wallets").doc(req.userId!);

    const order = await db.runTransaction(async (tx) => {
      const productDoc = await tx.get(productRef);
      if (!productDoc.exists) throw Errors.notFound("Product");
      const product = productDoc.data()!;

      if (product.status !== "available") {
        throw Errors.conflict("Product is no longer available");
      }
      if (product.sellerId === req.userId) {
        throw Errors.badRequest("You cannot buy your own product");
      }

      const total = Number(product.price) * qty; // السعر من السيرفر، مش من التطبيق
      const buyerWalletDoc = await tx.get(buyerWalletRef);
      const buyerBalance = buyerWalletDoc.exists ? buyerWalletDoc.data()!.balance || 0 : 0;
      if (buyerBalance < total) throw Errors.insufficientBalance();

      const sellerRef = db.collection("users").doc(product.sellerId);
      const sellerDoc = await tx.get(sellerRef);
      const sellerName = sellerDoc.exists
        ? sellerDoc.data()!.displayName || sellerDoc.data()!.username
        : null;

      const sellerWalletRef = db.collection("wallets").doc(product.sellerId);
      const sellerWalletDoc = await tx.get(sellerWalletRef);
      const sellerPending = sellerWalletDoc.exists
        ? sellerWalletDoc.data()!.pendingBalance || 0
        : 0;

      const now = new Date().toISOString();
      const orderId = uuid();
      const orderData = {
        buyerId: req.userId,
        sellerId: product.sellerId,
        sellerName,
        status: "completed",
        items: [
          {
            id: uuid(),
            productId,
            title: product.title,
            imageUrl: (product.images && product.images[0]) || null,
            price: product.price,
            currency: product.currency,
            quantity: qty,
          },
        ],
        total,
        currency: product.currency,
        createdAt: now,
        updatedAt: now,
      };

      tx.set(db.collection("orders").doc(orderId), orderData);
      tx.update(productRef, { status: "sold", updatedAt: now });
      tx.set(
        buyerWalletRef,
        { balance: buyerBalance - total },
        { merge: true }
      );
      // رصيد البائع بيتحط "معلق" (pending) — تقدر لاحقًا تضيف منطق تحرير الرصيد
      // بعد فترة ضمان (escrow) بدل ما يتحول فورًا لـ balance
      tx.set(
        sellerWalletRef,
        { pendingBalance: sellerPending + total },
        { merge: true }
      );
      tx.set(db.collection("transactions").doc(uuid()), {
        userId: req.userId,
        type: "purchase",
        amount: -total,
        currency: product.currency,
        description: `Purchase: ${product.title}`,
        status: "completed",
        createdAt: now,
      });
      tx.set(db.collection("transactions").doc(uuid()), {
        userId: product.sellerId,
        type: "sale_pending",
        amount: total,
        currency: product.currency,
        description: `Sale (pending): ${product.title}`,
        status: "pending",
        createdAt: now,
      });

      return { id: orderId, data: orderData };
    });

    res.status(201).json(toOrderDto(order.id, order.data));
  } catch (err) {
    next(err);
  }
});

// POST /orders/:id/cancel — المشتري بس، ولو لسه completed حديثًا (مثال بسيط)
router.post("/:id/cancel", async (req, res, next) => {
  try {
    const orderRef = db.collection("orders").doc(req.params.id);
    const updated = await db.runTransaction(async (tx) => {
      const doc = await tx.get(orderRef);
      if (!doc.exists) throw Errors.notFound("Order");
      const d = doc.data()!;
      if (d.buyerId !== req.userId) throw Errors.forbidden("Not your order");
      if (d.status === "cancelled") throw Errors.conflict("Already cancelled");

      const now = new Date().toISOString();
      tx.update(orderRef, { status: "cancelled", updatedAt: now });

      const productId = d.items?.[0]?.productId;
      if (productId) {
        tx.update(db.collection("products").doc(productId), {
          status: "available",
          updatedAt: now,
        });
      }
      // استرجاع الفلوس للمشتري
      const buyerWalletRef = db.collection("wallets").doc(d.buyerId);
      const buyerWalletDoc = await tx.get(buyerWalletRef);
      const buyerBalance = buyerWalletDoc.exists ? buyerWalletDoc.data()!.balance || 0 : 0;
      tx.set(buyerWalletRef, { balance: buyerBalance + d.total }, { merge: true });

      const sellerWalletRef = db.collection("wallets").doc(d.sellerId);
      const sellerWalletDoc = await tx.get(sellerWalletRef);
      const sellerPending = sellerWalletDoc.exists
        ? sellerWalletDoc.data()!.pendingBalance || 0
        : 0;
      tx.set(
        sellerWalletRef,
        { pendingBalance: Math.max(0, sellerPending - d.total) },
        { merge: true }
      );

      return { id: doc.id, data: { ...d, status: "cancelled", updatedAt: now } };
    });

    res.json(toOrderDto(updated.id, updated.data));
  } catch (err) {
    next(err);
  }
});

export default router;
