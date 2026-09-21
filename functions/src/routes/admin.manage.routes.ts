import { Router } from "express";
import * as admin from "firebase-admin";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { checkAdminKey } from "../lib/adminAuth";
import { logAdminAction } from "../lib/adminAudit";
import { PushItem, sendPushBatch } from "../lib/push";
import { disputeConversationId, sendDisputeMessage } from "../lib/disputes";

/*
 * =========================================================
 * ADMIN — إدارة الطلبات والنزاعات والمستخدمين والمنتجات
 *
 * كل المسارات هنا محمية بمفتاح الإدارة (x-admin-key) ومنطق
 * الفلوس كله Server-side داخل Firestore transactions.
 * =========================================================
 */

const router = Router();

function nowIso(): string {
  return new Date().toISOString();
}

// حالات الطلب اللي الفلوس فيها لسه محجوزة (Escrow).
const ESCROW_STATES = [
  "PENDING_SELLER_APPROVAL",
  "SELLER_ACCEPTED",
  "CHAT_ACTIVE",
  "ACCOUNT_DELIVERED",
  "BUYER_TESTING",
  "DISPUTED",
];

// حالات يجوز فيها تسليم الفلوس للبائع (الحساب اتسلّم فعلاً).
const RELEASE_STATES = ["ACCOUNT_DELIVERED", "BUYER_TESTING", "DISPUTED"];

function cleanText(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

/* =========================================================
   DTOs
   ========================================================= */

function toAdminOrderDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    id,
    status: d.status ?? null,
    total: d.total ?? 0,
    currency: d.currency ?? null,
    buyerId: d.buyerId ?? null,
    sellerId: d.sellerId ?? null,
    sellerName: d.sellerName ?? null,
    productId: d.productId ?? d.items?.[0]?.productId ?? null,
    productTitle: d.items?.[0]?.title ?? null,
    conversationId: d.conversationId ?? null,
    disputeReason: d.disputeReason ?? null,
    disputedAt: d.disputedAt ?? null,
    deliveredAt: d.deliveredAt ?? null,
    completedAt: d.completedAt ?? null,
    refundedAt: d.refundedAt ?? null,
    refundReason: d.refundReason ?? null,
    resolutionNote: d.resolutionNote ?? null,
    resolvedBy: d.resolvedBy ?? null,
    resolvedAt: d.resolvedAt ?? null,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

function toAdminUserDto(
  id: string,
  d: FirebaseFirestore.DocumentData,
  wallet?: FirebaseFirestore.DocumentData | null
) {
  return {
    id,
    username: d.username ?? null,
    displayName: d.displayName ?? null,
    email: d.email ?? null,
    isSeller: d.isSeller ?? false,
    verified: d.verified ?? false,
    frozen: d.frozen === true,
    frozenReason: d.frozenReason ?? null,
    frozenAt: d.frozenAt ?? null,
    createdAt: d.createdAt ?? null,
    balance: wallet ? Number(wallet.balance ?? 0) : null,
    pendingBalance: wallet ? Number(wallet.pendingBalance ?? 0) : null,
    heldBalance: wallet ? Number(wallet.heldBalance ?? 0) : null,
    currency: wallet?.currency ?? null,
  };
}

async function loadUserBrief(userId: string | null | undefined) {
  if (!userId) return null;
  const doc = await db.collection("users").doc(userId).get();
  if (!doc.exists) return { id: userId, displayName: null, username: null, email: null, frozen: false };
  const d = doc.data()!;
  return {
    id: userId,
    displayName: d.displayName ?? null,
    username: d.username ?? null,
    email: d.email ?? null,
    frozen: d.frozen === true,
  };
}

async function loadMessages(conversationId: string | null | undefined, limit = 200) {
  if (!conversationId) return [];
  const snap = await db
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snap.docs
    .map((m) => ({
      id: m.id,
      senderId: m.data().senderId ?? null,
      text: m.data().text ?? null,
      createdAt: m.data().createdAt ?? null,
      system: m.data().system === true,
    }))
    .reverse();
}

/* =========================================================
   ORDERS / DISPUTES
   ========================================================= */

// GET /admin/orders?status=DISPUTED&limit=100
router.get("/orders", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const status = cleanText(req.query.status, 40);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    let docs: FirebaseFirestore.QueryDocumentSnapshot[];

    if (status) {
      // فلتر واحد بدون orderBy: مايحتاجش composite index، والترتيب بيتم هنا.
      const snap = await db.collection("orders").where("status", "==", status).get();
      docs = snap.docs;
    } else {
      const snap = await db.collection("orders").orderBy("createdAt", "desc").limit(limit).get();
      docs = snap.docs;
    }

    const orders = docs
      .map((d) => toAdminOrderDto(d.id, d.data()))
      .sort((a, b) =>
        String(b.disputedAt || b.createdAt || "").localeCompare(String(a.disputedAt || a.createdAt || ""))
      )
      .slice(0, limit);

    // أسماء الأطراف (طلب واحد لكل مستخدم مختلف).
    const ids = Array.from(
      new Set(orders.flatMap((o) => [o.buyerId, o.sellerId]).filter((x): x is string => !!x))
    );
    const userDocs = ids.length
      ? await db.getAll(...ids.map((id) => db.collection("users").doc(id)))
      : [];
    const names: Record<string, string> = {};
    userDocs.forEach((u) => {
      if (u.exists) {
        const d = u.data()!;
        names[u.id] = d.displayName || d.username || u.id;
      }
    });

    res.json({
      ok: true,
      orders: orders.map((o) => ({
        ...o,
        buyerName: o.buyerId ? names[o.buyerId] ?? null : null,
        sellerName: o.sellerName ?? (o.sellerId ? names[o.sellerId] ?? null : null),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/orders/:id  (تفاصيل + الأطراف + كل المحادثات المرتبطة)
router.get("/orders/:id", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const doc = await db.collection("orders").doc(req.params.id).get();
    if (!doc.exists) throw Errors.notFound("Order");

    const d = doc.data()!;
    const order = toAdminOrderDto(doc.id, d);

    const [buyer, seller, orderChat, buyerThread, sellerThread] = await Promise.all([
      loadUserBrief(d.buyerId),
      loadUserBrief(d.sellerId),
      loadMessages(d.conversationId),
      d.buyerId ? loadMessages(disputeConversationId(doc.id, d.buyerId)) : Promise.resolve([]),
      d.sellerId ? loadMessages(disputeConversationId(doc.id, d.sellerId)) : Promise.resolve([]),
    ]);

    res.json({
      ok: true,
      order,
      buyer,
      seller,
      orderChat,
      threads: { buyer: buyerThread, seller: sellerThread },
      canRefund: ESCROW_STATES.includes(d.status),
      canRelease: RELEASE_STATES.includes(d.status),
    });
  } catch (err) {
    next(err);
  }
});

/*
 * تسوية الأموال لطلب (استرجاع للمشتري أو تسليم للبائع) داخل transaction واحدة:
 *  - refund : balance المشتري += total ، held المشتري -= total ، pending البائع -= total
 *  - release: held المشتري -= total ، pending البائع -= total ، balance البائع += total
 * حالة الطلب بتتراجع جوه الـ transaction، فمستحيل التسوية تتنفذ مرتين.
 */
async function settleOrder(orderId: string, action: "refund" | "release", note: string | null) {
  const orderRef = db.collection("orders").doc(orderId);
  const pushQueue: PushItem[] = [];

  const result = await db.runTransaction(async (tx) => {
    pushQueue.length = 0;

    const orderDoc = await tx.get(orderRef);
    if (!orderDoc.exists) throw Errors.notFound("Order");

    const d = orderDoc.data()!;
    const allowed = action === "refund" ? ESCROW_STATES : RELEASE_STATES;

    if (!allowed.includes(d.status)) {
      throw Errors.conflict(`Order cannot be ${action === "refund" ? "refunded" : "released"} from status ${d.status}`);
    }

    const total = Number(d.total);
    if (!Number.isFinite(total) || total <= 0) {
      throw Errors.conflict("Order total is invalid");
    }

    const buyerWalletRef = db.collection("wallets").doc(d.buyerId);
    const sellerWalletRef = db.collection("wallets").doc(d.sellerId);
    const productId = d.productId || d.items?.[0]?.productId;
    const productRef = productId ? db.collection("products").doc(productId) : null;
    const conversationRef = d.conversationId ? db.collection("conversations").doc(d.conversationId) : null;

    // كل القراءات قبل أي كتابة.
    const [buyerWalletDoc, sellerWalletDoc, productDoc, conversationDoc] = await Promise.all([
      tx.get(buyerWalletRef),
      tx.get(sellerWalletRef),
      productRef ? tx.get(productRef) : Promise.resolve(null),
      conversationRef ? tx.get(conversationRef) : Promise.resolve(null),
    ]);

    const buyerWallet = buyerWalletDoc.exists ? buyerWalletDoc.data()! : {};
    const sellerWallet = sellerWalletDoc.exists ? sellerWalletDoc.data()! : {};

    const buyerBalance = Number(buyerWallet.balance ?? 0);
    const buyerHeld = Number(buyerWallet.heldBalance ?? 0);
    const sellerBalance = Number(sellerWallet.balance ?? 0);
    const sellerPending = Number(sellerWallet.pendingBalance ?? 0);
    const now = nowIso();

    if (action === "refund") {
      tx.set(
        buyerWalletRef,
        {
          balance: buyerBalance + total,
          heldBalance: Math.max(0, buyerHeld - total),
          currency: buyerWallet.currency || d.currency,
          updatedAt: now,
        },
        { merge: true }
      );

      tx.set(
        sellerWalletRef,
        { pendingBalance: Math.max(0, sellerPending - total), updatedAt: now },
        { merge: true }
      );
    } else {
      tx.set(
        buyerWalletRef,
        { heldBalance: Math.max(0, buyerHeld - total), updatedAt: now },
        { merge: true }
      );

      tx.set(
        sellerWalletRef,
        {
          pendingBalance: Math.max(0, sellerPending - total),
          balance: sellerBalance + total,
          currency: sellerWallet.currency || d.currency,
          updatedAt: now,
        },
        { merge: true }
      );
    }

    if (productRef && productDoc?.exists) {
      tx.update(
        productRef,
        action === "refund"
          ? { status: "available", reservedOrderId: null, reservedAt: null, updatedAt: now }
          : { status: "sold", reservedOrderId: null, updatedAt: now }
      );
    }

    const wasDisputed = d.status === "DISPUTED";
    const orderUpdate: Record<string, unknown> =
      action === "refund"
        ? {
            status: "REFUNDED",
            refundReason: wasDisputed ? "ADMIN_DISPUTE_REFUND" : "ADMIN_REFUND",
            refundedAt: now,
          }
        : {
            status: "COMPLETED",
            completedAt: now,
            releasedByAdmin: true,
          };

    tx.update(orderRef, {
      ...orderUpdate,
      resolutionNote: note,
      resolvedBy: "admin",
      resolvedAt: now,
      updatedAt: now,
    });

    const txRef = (userId: string, type: string, amount: number, description: string, status: string) =>
      tx.set(db.collection("transactions").doc(uuid()), {
        userId,
        orderId,
        type,
        amount,
        currency: d.currency,
        description,
        status,
        createdAt: now,
      });

    const notify = (userId: string, type: string, title: string, body: string) => {
      tx.set(db.collection("notifications").doc(uuid()), {
        userId,
        type,
        title,
        body,
        orderId,
        read: false,
        createdAt: now,
      });
      pushQueue.push({ userId, title, body, data: { type, orderId } });
    };

    let systemText: string;

    if (action === "refund") {
      txRef(d.buyerId, "purchase_refund", total, "Refund by admin", "completed");
      txRef(d.sellerId, "sale_cancelled", -total, "Sale cancelled by admin (refund to buyer)", "cancelled");

      notify(
        d.buyerId,
        "ORDER_REFUNDED",
        "تم رد المبلغ",
        wasDisputed
          ? "قررت الإدارة لصالحك في النزاع وتمت إعادة المبلغ إلى رصيدك."
          : "قامت الإدارة بإعادة المبلغ إلى رصيدك."
      );
      notify(
        d.sellerId,
        "ORDER_REFUNDED_BY_ADMIN",
        "تم إلغاء الطلب بقرار الإدارة",
        "قررت الإدارة إعادة المبلغ للمشتري وإلغاء الطلب."
      );

      systemText = "قررت الإدارة إعادة المبلغ للمشتري وإغلاق الطلب.";
    } else {
      txRef(d.buyerId, "purchase_completed", 0, "Order completed by admin - held funds released", "completed");
      txRef(d.sellerId, "sale_completed", total, "Sale completed by admin - funds released to balance", "completed");

      notify(
        d.sellerId,
        "ORDER_COMPLETED",
        "تم تحويل المبلغ إلى رصيدك",
        wasDisputed
          ? "قررت الإدارة لصالحك في النزاع وتم تحويل المبلغ إلى رصيدك."
          : "قامت الإدارة بتحويل مبلغ الطلب إلى رصيدك."
      );
      notify(
        d.buyerId,
        "ORDER_COMPLETED_BY_ADMIN",
        "تم إغلاق الطلب بقرار الإدارة",
        "قررت الإدارة تسليم المبلغ للبائع وإغلاق الطلب."
      );

      systemText = "قررت الإدارة تسليم المبلغ للبائع وإغلاق الطلب.";
    }

    if (conversationRef && conversationDoc?.exists) {
      tx.update(conversationRef, { lastMessage: systemText, lastMessageAt: now, updatedAt: now });
      tx.set(conversationRef.collection("messages").doc(uuid()), {
        conversationId: d.conversationId,
        senderId: "admin",
        text: systemText,
        createdAt: now,
        status: "sent",
        system: true,
      });
    }

    const updated: FirebaseFirestore.DocumentData = {
      ...d,
      ...orderUpdate,
      resolutionNote: note,
      resolvedBy: "admin",
      resolvedAt: now,
      updatedAt: now,
    };

    return updated;
  });

  await sendPushBatch(pushQueue);

  return result;
}

// POST /admin/orders/:id/settle   { action: "refund" | "release", note? }
router.post("/orders/:id/settle", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const action = req.body?.action;
    if (action !== "refund" && action !== "release") {
      throw Errors.badRequest('action must be "refund" or "release"');
    }

    const note = cleanText(req.body?.note);
    const order = await settleOrder(req.params.id, action, note);

    await logAdminAction({
      action: action === "refund" ? "order_refund" : "order_release",
      targetType: "order",
      targetId: req.params.id,
      note,
      meta: { total: order.total, buyerId: order.buyerId, sellerId: order.sellerId },
    });

    res.json({ ok: true, order: toAdminOrderDto(req.params.id, order) });
  } catch (err) {
    next(err);
  }
});

// POST /admin/orders/:id/message   { text, target: "buyer" | "seller" | "both" }
router.post("/orders/:id/message", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const text = cleanText(req.body?.text, 2000);
    if (!text) throw Errors.badRequest("text is required");

    const target = req.body?.target;
    if (target !== "buyer" && target !== "seller" && target !== "both") {
      throw Errors.badRequest('target must be "buyer", "seller" or "both"');
    }

    const doc = await db.collection("orders").doc(req.params.id).get();
    if (!doc.exists) throw Errors.notFound("Order");
    const d = doc.data()!;

    const sent: Record<string, string> = {};

    if ((target === "buyer" || target === "both") && d.buyerId) {
      const r = await sendDisputeMessage(doc.id, d.buyerId, text, "buyer");
      sent.buyer = r.conversationId;
    }

    if ((target === "seller" || target === "both") && d.sellerId) {
      const r = await sendDisputeMessage(doc.id, d.sellerId, text, "seller");
      sent.seller = r.conversationId;
    }

    await logAdminAction({
      action: "order_message",
      targetType: "order",
      targetId: doc.id,
      note: text.slice(0, 200),
      meta: { target },
    });

    res.status(201).json({ ok: true, sent });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   USERS (تجميد / فك تجميد)
   ========================================================= */

// GET /admin/users?q=&limit=
router.get("/users", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const q = (cleanText(req.query.q, 80) || "").toLowerCase();
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));

    // لو فيه بحث، بنجيب دفعة أكبر ونفلتر هنا (مفيش full-text search في Firestore).
    const snap = await db
      .collection("users")
      .orderBy("createdAt", "desc")
      .limit(q ? 500 : limit)
      .get();

    let docs = snap.docs;

    if (q) {
      docs = docs.filter((u) => {
        const d = u.data();
        return [d.username, d.displayName, d.email, u.id].some((v) => String(v || "").toLowerCase().includes(q));
      });
    }

    docs = docs.slice(0, limit);

    const wallets = docs.length ? await db.getAll(...docs.map((u) => db.collection("wallets").doc(u.id))) : [];
    const walletById: Record<string, FirebaseFirestore.DocumentData> = {};
    wallets.forEach((w) => {
      if (w.exists) walletById[w.id] = w.data()!;
    });

    res.json({
      ok: true,
      users: docs.map((u) => toAdminUserDto(u.id, u.data(), walletById[u.id] ?? null)),
    });
  } catch (err) {
    next(err);
  }
});

async function setFrozen(userId: string, frozen: boolean, reason: string | null) {
  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) throw Errors.notFound("User");

  const now = nowIso();

  await userRef.set(
    frozen
      ? { frozen: true, frozenReason: reason, frozenAt: now, updatedAt: now }
      : { frozen: false, frozenReason: null, frozenAt: null, unfrozenAt: now, updatedAt: now },
    { merge: true }
  );

  /*
   * التجميد الفعلي: تعطيل الحساب في Firebase Auth + إبطال الـ refresh tokens،
   * و middleware/auth.ts بيرفض أي طلب من حساب معطّل. لو الحساب مش موجود في Auth
   * (بيانات قديمة) بنكمل بعلامة frozen في Firestore بس.
   */
  try {
    await admin.auth().updateUser(userId, { disabled: frozen });
    if (frozen) {
      await admin.auth().revokeRefreshTokens(userId);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("setFrozen: auth update failed for", userId, err);
  }
}

// POST /admin/users/:id/freeze   { reason? }
router.post("/users/:id/freeze", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const reason = cleanText(req.body?.reason, 500);
    await setFrozen(req.params.id, true, reason);

    await logAdminAction({ action: "user_freeze", targetType: "user", targetId: req.params.id, note: reason });

    res.json({ ok: true, frozen: true });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id/unfreeze
router.post("/users/:id/unfreeze", async (req, res, next) => {
  try {
    checkAdminKey(req);

    await setFrozen(req.params.id, false, null);

    await logAdminAction({ action: "user_unfreeze", targetType: "user", targetId: req.params.id });

    res.json({ ok: true, frozen: false });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users/:id/wallet  (الرصيد + آخر المعاملات)
router.get("/users/:id/wallet", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const walletDoc = await db.collection("wallets").doc(req.params.id).get();
    const w = walletDoc.exists ? walletDoc.data()! : {};

    let txDocs: FirebaseFirestore.QueryDocumentSnapshot[];

    try {
      const snap = await db
        .collection("transactions")
        .where("userId", "==", req.params.id)
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();
      txDocs = snap.docs;
    } catch {
      // لو الـ composite index مش منشور، بنجيب بدون ترتيب ونرتب هنا.
      const snap = await db.collection("transactions").where("userId", "==", req.params.id).limit(500).get();
      txDocs = snap.docs
        .sort((a, b) => String(b.data().createdAt || "").localeCompare(String(a.data().createdAt || "")))
        .slice(0, 50);
    }

    res.json({
      ok: true,
      wallet: {
        balance: Number(w.balance ?? 0),
        pendingBalance: Number(w.pendingBalance ?? 0),
        heldBalance: Number(w.heldBalance ?? 0),
        currency: w.currency ?? "EGP",
      },
      transactions: txDocs.map((t) => ({
        id: t.id,
        type: t.data().type ?? null,
        amount: t.data().amount ?? 0,
        currency: t.data().currency ?? null,
        description: t.data().description ?? null,
        status: t.data().status ?? null,
        orderId: t.data().orderId ?? null,
        createdAt: t.data().createdAt ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   PRODUCTS (إخفاء / إظهار)
   ========================================================= */

// GET /admin/products?q=&status=
router.get("/products", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const q = (cleanText(req.query.q, 80) || "").toLowerCase();
    const status = cleanText(req.query.status, 20);

    let query: FirebaseFirestore.Query = db.collection("products");
    if (status) query = query.where("status", "==", status);

    const snap = status
      ? await query.limit(500).get()
      : await query.orderBy("createdAt", "desc").limit(300).get();

    let items = snap.docs.map((p) => {
      const d = p.data();
      return {
        id: p.id,
        title: d.title ?? null,
        price: d.price ?? 0,
        currency: d.currency ?? null,
        sellerId: d.sellerId ?? null,
        status: d.status ?? "available",
        hiddenByAdmin: d.hiddenByAdmin === true,
        hiddenReason: d.hiddenReason ?? null,
        createdAt: d.createdAt ?? null,
      };
    });

    if (q) {
      items = items.filter((p) => [p.title, p.id, p.sellerId].some((v) => String(v || "").toLowerCase().includes(q)));
    }

    items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    res.json({ ok: true, products: items.slice(0, 200) });
  } catch (err) {
    next(err);
  }
});

// POST /admin/products/:id/hide   { reason? }   |   POST /admin/products/:id/unhide
router.post("/products/:id/hide", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const ref = db.collection("products").doc(req.params.id);
    const reason = cleanText(req.body?.reason, 500);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw Errors.notFound("Product");

      // منتج محجوز أو مباع مايتخفيش: عليه طلب شغال.
      if (doc.data()!.status !== "available") {
        throw Errors.conflict("Only available products can be hidden");
      }

      tx.update(ref, {
        status: "hidden",
        hiddenByAdmin: true,
        hiddenReason: reason,
        hiddenAt: nowIso(),
        updatedAt: nowIso(),
      });
    });

    await logAdminAction({ action: "product_hide", targetType: "product", targetId: req.params.id, note: reason });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/products/:id/unhide", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const ref = db.collection("products").doc(req.params.id);

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw Errors.notFound("Product");

      if (doc.data()!.hiddenByAdmin !== true) {
        throw Errors.conflict("Product was not hidden by admin");
      }

      tx.update(ref, {
        status: "available",
        hiddenByAdmin: false,
        hiddenReason: null,
        hiddenAt: null,
        updatedAt: nowIso(),
      });
    });

    await logAdminAction({ action: "product_unhide", targetType: "product", targetId: req.params.id });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   AUDIT LOG
   ========================================================= */

// GET /admin/actions?limit=50
router.get("/actions", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const snap = await db.collection("adminActions").orderBy("createdAt", "desc").limit(limit).get();

    res.json({
      ok: true,
      actions: snap.docs.map((a) => ({ id: a.id, ...a.data() })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
