import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { PushItem, sendPushBatch } from "../lib/push";
import {
  parsePageParams,
  buildPaginatedResponse,
} from "../lib/pagination";

const router = Router();

router.use(requireAuth);

/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

const SELLER_APPROVAL_TIMEOUT_HOURS = Math.min(
  24,
  Math.max(
    1,
    Number(process.env.SELLER_APPROVAL_TIMEOUT_HOURS || 24)
  )
);

function nowIso(): string {
  return new Date().toISOString();
}

function toOrderDto(
  id: string,
  d: FirebaseFirestore.DocumentData
) {
  return {
    id,
    status: d.status ?? null,

    items: d.items ?? [],

    total: Number(d.total ?? 0),

    currency: d.currency ?? "USD",

    buyerId: d.buyerId ?? null,

    sellerId: d.sellerId ?? null,

    sellerName: d.sellerName ?? null,

    productId: d.productId ?? d.items?.[0]?.productId ?? null,

    conversationId: d.conversationId ?? null,

    sellerApprovalExpiresAt:
      d.sellerApprovalExpiresAt ?? null,

    sellerApprovedAt:
      d.sellerApprovedAt ?? null,

    deliveredAt:
      d.deliveredAt ?? null,

    buyerTestingStartedAt:
      d.buyerTestingStartedAt ?? null,

    completedAt:
      d.completedAt ?? null,

    refundedAt:
      d.refundedAt ?? null,

    disputedAt:
      d.disputedAt ?? null,

    disputeReason:
      d.disputeReason ?? null,

    createdAt:
      d.createdAt ?? null,

    updatedAt:
      d.updatedAt ?? null,
  };
}

function approvalExpired(d: FirebaseFirestore.DocumentData): boolean {
  if (d.status !== "PENDING_SELLER_APPROVAL") {
    return false;
  }

  if (!d.sellerApprovalExpiresAt) {
    return false;
  }

  const expiresAt =
    new Date(d.sellerApprovalExpiresAt).getTime();

  return (
    Number.isFinite(expiresAt) &&
    Date.now() >= expiresAt
  );
}

/*
 * رد المبلغ تلقائيًا لأوردر انتهت مهلة موافقة البائع عليه
 * من غير ما يرد. بيتنفذ داخل transaction مستقلة.
 */
async function refundExpiredOrder(orderId: string): Promise<void> {
  const orderRef = db.collection("orders").doc(orderId);
  const pushQueue: PushItem[] = [];

  await db.runTransaction(async (tx) => {
    pushQueue.length = 0; // احتياطًا لو الـ transaction اتعادت بسبب تعارض

    const orderDoc = await tx.get(orderRef);

    if (!orderDoc.exists) {
      return;
    }

    const d = orderDoc.data()!;

    // تأكيد إن الأوردر لسه فعلاً منتهي ومنتظر موافقة، عشان لو
    // حصل تحديث بين القراءة الأولى وهنا منعملش refund مرتين.
    if (!approvalExpired(d)) {
      return;
    }

    const buyerWalletRef = db.collection("wallets").doc(d.buyerId);
    const sellerWalletRef = db.collection("wallets").doc(d.sellerId);

    const [buyerWalletDoc, sellerWalletDoc] = await Promise.all([
      tx.get(buyerWalletRef),
      tx.get(sellerWalletRef),
    ]);

    const buyerWallet = buyerWalletDoc.exists ? buyerWalletDoc.data()! : {};
    const sellerWallet = sellerWalletDoc.exists ? sellerWalletDoc.data()! : {};

    const buyerBalance = Number(buyerWallet.balance ?? 0);
    const buyerHeld = Number(buyerWallet.heldBalance ?? 0);
    const sellerPending = Number(sellerWallet.pendingBalance ?? 0);
    const total = Number(d.total);
    const now = nowIso();

    tx.set(
      buyerWalletRef,
      {
        balance: buyerBalance + total,
        heldBalance: Math.max(0, buyerHeld - total),
        updatedAt: now,
      },
      { merge: true }
    );

    tx.set(
      sellerWalletRef,
      {
        pendingBalance: Math.max(0, sellerPending - total),
        updatedAt: now,
      },
      { merge: true }
    );

    const productId = d.productId || d.items?.[0]?.productId;

    if (productId) {
      tx.update(db.collection("products").doc(productId), {
        status: "available",
        reservedOrderId: null,
        reservedAt: null,
        updatedAt: now,
      });
    }

    tx.update(orderRef, {
      status: "REFUNDED",
      refundReason: "SELLER_APPROVAL_TIMEOUT",
      refundedAt: now,
      updatedAt: now,
    });

    createFinancialTransaction(tx, {
      userId: d.buyerId,
      orderId,
      type: "purchase_refund",
      amount: total,
      currency: d.currency,
      description: "Refund after seller approval timeout",
      status: "completed",
    });

    createFinancialTransaction(tx, {
      userId: d.sellerId,
      orderId,
      type: "sale_cancelled",
      amount: -total,
      currency: d.currency,
      description: "Pending sale cancelled (approval timeout)",
      status: "cancelled",
    });

    createNotification(
      tx,
      d.buyerId,
      "ORDER_REFUNDED",
      "تم رد المبلغ",
      "انتهت مهلة موافقة البائع وتمت إعادة المبلغ إلى رصيدك.",
      orderId,
      pushQueue
    );

    createNotification(
      tx,
      d.sellerId,
      "ORDER_EXPIRED",
      "انتهت مهلة الموافقة على الطلب",
      "انتهت مهلة موافقتك على الطلب وتم إلغاؤه تلقائيًا.",
      orderId,
      pushQueue
    );
  });

  await sendPushBatch(pushQueue);
}

/*
 * إنشاء إشعار من داخل Firestore transaction، ولو اتبعتله
 * pushQueue، بنضيف نسخة منه عشان نبعتها كـ Push حقيقي (FCM)
 * بعد ما الـ transaction تنجح وتتقفل (مش من جواها).
 */
function createNotification(
  tx: FirebaseFirestore.Transaction,
  userId: string,
  type: string,
  title: string,
  body: string,
  orderId?: string,
  pushQueue?: PushItem[]
) {
  const ref = db
    .collection("notifications")
    .doc(uuid());

  tx.set(ref, {
    userId,
    type,
    title,
    body,
    orderId: orderId ?? null,
    read: false,
    createdAt: nowIso(),
  });

  if (pushQueue) {
    pushQueue.push({
      userId,
      title,
      body,
      data: {
        type,
        orderId: orderId ?? "",
      },
    });
  }
}

/*
 * إنشاء Transaction مالية.
 */
function createFinancialTransaction(
  tx: FirebaseFirestore.Transaction,
  data: {
    userId: string;
    orderId: string;
    type: string;
    amount: number;
    currency: string;
    description: string;
    status: string;
  }
) {
  const ref = db
    .collection("transactions")
    .doc(uuid());

  tx.set(ref, {
    userId: data.userId,
    orderId: data.orderId,
    type: data.type,
    amount: data.amount,
    currency: data.currency,
    description: data.description,
    status: data.status,
    createdAt: nowIso(),
  });
}

/*
 * =========================================================
 * GET /orders
 * أوردرات المشتري
 * =========================================================
 */

router.get(
  "/",
  async (req, res, next) => {
    try {
      let q: FirebaseFirestore.Query =
        db
          .collection("orders")
          .where(
            "buyerId",
            "==",
            req.userId
          );

      if (req.query.status) {
        q = q.where(
          "status",
          "==",
          req.query.status
        );
      }

      q = q.orderBy(
        "createdAt",
        "desc"
      );

      const {
        page,
        limit,
      } = parsePageParams(
        req.query as any
      );

      const start =
        (page - 1) * limit;

      // بنجيب العدد الكلي والصفحة المطلوبة بس، بدل
      // ما نسحب لحد 500 أوردر ونقصّهم في الميموري.
      const [countSnap, pageSnap] =
        await Promise.all([
          q.count().get(),
          q
            .offset(start)
            .limit(limit)
            .get(),
        ]);

      const items = pageSnap.docs.map((d) =>
        toOrderDto(
          d.id,
          d.data()
        )
      );

      res.json(
        buildPaginatedResponse(
          items,
          countSnap.data().count,
          page,
          limit
        )
      );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * GET /orders/seller
 * أوردرات البائع
 * =========================================================
 */

router.get(
  "/seller",
  async (req, res, next) => {
    try {
      let q: FirebaseFirestore.Query =
        db
          .collection("orders")
          .where(
            "sellerId",
            "==",
            req.userId
          );

      if (req.query.status) {
        q = q.where(
          "status",
          "==",
          req.query.status
        );
      }

      q = q.orderBy(
        "createdAt",
        "desc"
      );

      const {
        page,
        limit,
      } = parsePageParams(
        req.query as any
      );

      const start =
        (page - 1) * limit;

      const [countSnap, pageSnap] =
        await Promise.all([
          q.count().get(),
          q
            .offset(start)
            .limit(limit)
            .get(),
        ]);

      const items = pageSnap.docs.map((d) =>
        toOrderDto(
          d.id,
          d.data()
        )
      );

      res.json(
        buildPaginatedResponse(
          items,
          countSnap.data().count,
          page,
          limit
        )
      );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * GET /orders/:id
 * المشتري أو البائع فقط
 * =========================================================
 */

router.get(
  "/:id",
  async (req, res, next) => {
    try {
      const ref = db
        .collection("orders")
        .doc(req.params.id);

      const doc = await ref.get();

      if (!doc.exists) {
        throw Errors.notFound("Order");
      }

      const d = doc.data()!;

      if (
        d.buyerId !== req.userId &&
        d.sellerId !== req.userId
      ) {
        throw Errors.forbidden(
          "Not your order"
        );
      }

      /*
       * لو الطلب انتهت مهلة موافقة البائع،
       * نحاول تنفيذ refund تلقائي عند فتح الطلب.
       */
      if (approvalExpired(d)) {
        await refundExpiredOrder(
          req.params.id
        );

        const refreshed =
          await ref.get();

        return res.json(
          toOrderDto(
            refreshed.id,
            refreshed.data()!
          )
        );
      }

      res.json(
        toOrderDto(
          doc.id,
          d
        )
      );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * POST /orders
 *
 * شراء المنتج
 *
 * الفلوس لا تنتقل للبائع هنا.
 * يتم حجزها فقط.
 * =========================================================
 */

router.post(
  "/",
  async (req, res, next) => {
    try {
      const {
        productId,
        quantity,
      } = req.body || {};

      if (!productId) {
        throw Errors.badRequest(
          "productId is required"
        );
      }

      const qty = Math.min(
        100,
        Math.max(
          1,
          Math.trunc(
            Number(quantity) || 1
          )
        )
      );

      const productRef =
        db
          .collection("products")
          .doc(productId);

      const buyerWalletRef =
        db
          .collection("wallets")
          .doc(req.userId!);

      const orderId = uuid();
      const pushQueue: PushItem[] = [];

      const result =
        await db.runTransaction(
          async (tx) => {
            pushQueue.length = 0;

            /*
             * كل القراءات قبل الكتابات.
             */

            const productDoc =
              await tx.get(
                productRef
              );

            if (!productDoc.exists) {
              throw Errors.notFound(
                "Product"
              );
            }

            const product =
              productDoc.data()!;

            if (
              product.status !==
              "available"
            ) {
              throw Errors.conflict(
                "Product is no longer available"
              );
            }

            if (
              product.sellerId ===
              req.userId
            ) {
              throw Errors.badRequest(
                "You cannot buy your own product"
              );
            }

            /*
             * حساب السعر من قاعدة البيانات.
             */
            const unitPrice =
              Number(
                product.price
              );

            if (
              !Number.isFinite(
                unitPrice
              ) ||
              unitPrice <= 0
            ) {
              throw Errors.badRequest(
                "Invalid product price"
              );
            }

            const total =
              unitPrice * qty;

            const buyerWalletDoc =
              await tx.get(
                buyerWalletRef
              );

            const buyerWallet =
              buyerWalletDoc.exists
                ? buyerWalletDoc.data()!
                : {};

            const buyerBalance =
              Number(
                buyerWallet.balance ?? 0
              );

            const buyerHeldBalance =
              Number(
                buyerWallet.heldBalance ?? 0
              );

            if (
              buyerBalance < total
            ) {
              throw Errors.insufficientBalance();
            }

            /*
             * بيانات البائع.
             */
            const sellerRef =
              db
                .collection("users")
                .doc(
                  product.sellerId
                );

            const sellerDoc =
              await tx.get(
                sellerRef
              );

            const sellerName =
              sellerDoc.exists
                ? sellerDoc.data()!
                    .displayName ||
                  sellerDoc.data()!
                    .username ||
                  null
                : null;

            /*
             * محفظة البائع.
             *
             * لن نضيف المال إلى balance.
             * فقط pendingBalance.
             */
            const sellerWalletRef =
              db
                .collection("wallets")
                .doc(
                  product.sellerId
                );

            const sellerWalletDoc =
              await tx.get(
                sellerWalletRef
              );

            const sellerWallet =
              sellerWalletDoc.exists
                ? sellerWalletDoc.data()!
                : {};

            const sellerPending =
              Number(
                sellerWallet.pendingBalance ??
                  0
              );

            /*
             * موعد انتهاء مهلة البائع.
             */
            const createdAt =
              new Date();

            const expiresAt =
              new Date(
                createdAt.getTime() +
                  SELLER_APPROVAL_TIMEOUT_HOURS *
                    60 *
                    60 *
                    1000
              );

            const now =
              createdAt.toISOString();

            const expiration =
              expiresAt.toISOString();

            /*
             * المحادثة الخاصة بالطلب.
             */
            const conversationId =
              uuid();

            const conversationRef =
              db
                .collection(
                  "conversations"
                )
                .doc(
                  conversationId
                );

            /*
             * الطلب.
             */
            const orderData = {
              buyerId:
                req.userId,

              sellerId:
                product.sellerId,

              sellerName,

              productId,

              status:
                "PENDING_SELLER_APPROVAL",

              conversationId,

              sellerApprovalExpiresAt:
                expiration,

              items: [
                {
                  id: uuid(),

                  productId,

                  title:
                    product.title,

                  imageUrl:
                    (
                      product.images &&
                      product.images[0]
                    ) ||
                    null,

                  price:
                    unitPrice,

                  currency:
                    product.currency,

                  quantity:
                    qty,
                },
              ],

              total,

              currency:
                product.currency,

              createdAt:
                now,

              updatedAt:
                now,
            };

            /*
             * إنشاء الطلب.
             */
            tx.set(
              db
                .collection("orders")
                .doc(orderId),
              orderData
            );

            /*
             * المنتج أصبح محجوزًا.
             * ليس sold بعد.
             */
            tx.update(
              productRef,
              {
                status:
                  "reserved",

                reservedOrderId:
                  orderId,

                reservedAt:
                  now,

                updatedAt:
                  now,
              }
            );

            /*
             * خصم المال من رصيد المشتري
             * ووضعه في heldBalance.
             */
            tx.set(
              buyerWalletRef,
              {
                balance:
                  buyerBalance -
                  total,

                heldBalance:
                  buyerHeldBalance +
                  total,

                currency:
                  buyerWallet.currency ||
                  product.currency,

                updatedAt:
                  now,
              },
              {
                merge: true,
              }
            );

            /*
             * البائع يحصل على pendingBalance
             * فقط، وليس balance قابل للسحب.
             */
            tx.set(
              sellerWalletRef,
              {
                pendingBalance:
                  sellerPending +
                  total,

                currency:
                  sellerWallet.currency ||
                  product.currency,

                updatedAt:
                  now,
              },
              {
                merge: true,
              }
            );

            /*
             * إنشاء المحادثة.
             */
            tx.set(
              conversationRef,
              {
                participantIds: [
                  req.userId,
                  product.sellerId,
                ],

                otherUserNames: {
                  [req.userId!]:
                    null,

                  [product.sellerId]:
                    sellerName,
                },

                otherUserAvatars: {},

                unreadCounts: {
                  [req.userId!]:
                    0,

                  [product.sellerId]:
                    1,
                },

                lastMessage:
                  "تم إنشاء طلب شراء جديد. في انتظار موافقة البائع.",

                lastMessageAt:
                  now,

                productId,

                orderId,

                createdAt:
                  now,

                updatedAt:
                  now,
              }
            );

            /*
             * رسالة النظام الأولى في المحادثة.
             */
            const messageRef =
              conversationRef
                .collection(
                  "messages"
                )
                .doc(uuid());

            tx.set(
              messageRef,
              {
                conversationId,

                senderId:
                  req.userId,

                text:
                  "تم إنشاء طلب الشراء. في انتظار موافقة البائع.",

                createdAt:
                  now,

                status:
                  "sent",

                system:
                  true,
              }
            );

            /*
             * Transaction للمشتري.
             */
            createFinancialTransaction(
              tx,
              {
                userId:
                  req.userId!,

                orderId,

                type:
                  "purchase_held",

                amount:
                  -total,

                currency:
                  product.currency,

                description:
                  `Purchase held: ${product.title}`,

                status:
                  "held",
              }
            );

            /*
             * Transaction للبائع.
             */
            createFinancialTransaction(
              tx,
              {
                userId:
                  product.sellerId,

                orderId,

                type:
                  "sale_pending",

                amount:
                  total,

                currency:
                  product.currency,

                description:
                  `Sale pending approval: ${product.title}`,

                status:
                  "pending",
              }
            );

            /*
             * إشعار البائع.
             */
            createNotification(
              tx,
              product.sellerId,
              "ORDER_PENDING_APPROVAL",
              "طلب شراء جديد",
              `يوجد طلب شراء جديد على منتجك: ${product.title}`,
              orderId,
              pushQueue
            );

            return {
              id: orderId,
              data: orderData,
            };
          }
        );

      await sendPushBatch(pushQueue);

      res
        .status(201)
        .json(
          toOrderDto(
            result.id,
            result.data
          )
        );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * SELLER APPROVE
 *
 * POST /orders/:id/approve
 * =========================================================
 */

router.post(
  "/:id/approve",
  async (req, res, next) => {
    try {
      const orderRef =
        db
          .collection("orders")
          .doc(req.params.id);

      const pushQueue: PushItem[] = [];

      const result =
        await db.runTransaction(
          async (tx) => {
            pushQueue.length = 0;

            const orderDoc =
              await tx.get(
                orderRef
              );

            if (!orderDoc.exists) {
              throw Errors.notFound(
                "Order"
              );
            }

            const d =
              orderDoc.data()!;

            if (
              d.sellerId !==
              req.userId
            ) {
              throw Errors.forbidden(
                "Only the seller can approve this order"
              );
            }

            if (
              approvalExpired(d)
            ) {
              throw Errors.conflict(
                "Seller approval period has expired"
              );
            }

            if (
              d.status !==
              "PENDING_SELLER_APPROVAL"
            ) {
              throw Errors.conflict(
                "Order is not waiting for seller approval"
              );
            }

            const now =
              nowIso();

            /*
             * لازم كل الـ reads تتعمل قبل أي write
             * جوه Firestore transaction، فبنقرا المحادثة
             * الأول قبل ما نعمل أي update.
             */
            const conversationRef =
              d.conversationId
                ? db
                    .collection(
                      "conversations"
                    )
                    .doc(
                      d.conversationId
                    )
                : null;

            const conversationDoc =
              conversationRef
                ? await tx.get(
                    conversationRef
                  )
                : null;

            tx.update(
              orderRef,
              {
                status:
                  "SELLER_ACCEPTED",

                sellerApprovedAt:
                  now,

                updatedAt:
                  now,
              }
            );

            /*
             * تحديث المحادثة.
             */
            if (
              conversationRef &&
              conversationDoc?.exists
            ) {
              tx.update(
                conversationRef,
                {
                  lastMessage:
                    "وافق البائع على الطلب.",

                  lastMessageAt:
                    now,

                  updatedAt:
                    now,
                }
              );

              const messageRef =
                conversationRef
                  .collection(
                    "messages"
                  )
                  .doc(uuid());

              tx.set(
                messageRef,
                {
                  conversationId:
                    d.conversationId,

                  senderId:
                    req.userId,

                  text:
                    "وافق البائع على الطلب. يمكن بدء عملية التسليم.",

                  createdAt:
                    now,

                  status:
                    "sent",

                  system:
                    true,
                }
              );
            }

            createNotification(
              tx,
              d.buyerId,
              "ORDER_SELLER_ACCEPTED",
              "البائع وافق على الطلب",
              "وافق البائع على طلبك، اضغط لمراسلته لتسليم الحساب.",
              orderDoc.id,
              pushQueue
            );

            return {
              ...d,
              status:
                "SELLER_ACCEPTED",

              sellerApprovedAt:
                now,

              updatedAt:
                now,
            };
          }
        );

      await sendPushBatch(pushQueue);

      res.json(
        toOrderDto(
          req.params.id,
          result
        )
      );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * SELLER REJECT
 * =========================================================
 */

router.post(
  "/:id/reject",
  async (req, res, next) => {
    try {
      const orderRef =
        db
          .collection("orders")
          .doc(req.params.id);

      const pushQueue: PushItem[] = [];

      const result =
        await db.runTransaction(
          async (tx) => {
            pushQueue.length = 0;

            const orderDoc =
              await tx.get(orderRef);

            if (!orderDoc.exists) {
              throw Errors.notFound(
                "Order"
              );
            }

            const d =
              orderDoc.data()!;

            if (
              d.sellerId !==
              req.userId
            ) {
              throw Errors.forbidden(
                "Only the seller can reject this order"
              );
            }

            if (
              d.status !==
              "PENDING_SELLER_APPROVAL"
            ) {
              throw Errors.conflict(
                "Order cannot be rejected in its current state"
              );
            }

            const buyerWalletRef =
              db
                .collection("wallets")
                .doc(d.buyerId);

            const sellerWalletRef =
              db
                .collection("wallets")
                .doc(d.sellerId);

            const buyerWalletDoc =
              await tx.get(
                buyerWalletRef
              );

            const sellerWalletDoc =
              await tx.get(
                sellerWalletRef
              );

            const buyerWallet =
              buyerWalletDoc.exists
                ? buyerWalletDoc.data()!
                : {};

            const sellerWallet =
              sellerWalletDoc.exists
                ? sellerWalletDoc.data()!
                : {};

            const buyerBalance =
              Number(
                buyerWallet.balance ?? 0
              );

            const buyerHeld =
              Number(
                buyerWallet.heldBalance ?? 0
              );

            const sellerPending =
              Number(
                sellerWallet.pendingBalance ?? 0
              );

            const total =
              Number(d.total);

            const now =
              nowIso();

            tx.set(
              buyerWalletRef,
              {
                balance:
                  buyerBalance +
                  total,

                heldBalance:
                  Math.max(
                    0,
                    buyerHeld -
                      total
                  ),

                updatedAt:
                  now,
              },
              {
                merge: true,
              }
            );

            tx.set(
              sellerWalletRef,
              {
                pendingBalance:
                  Math.max(
                    0,
                    sellerPending -
                      total
                  ),

                updatedAt:
                  now,
              },
              {
                merge: true,
              }
            );

            const productId =
              d.productId ||
              d.items?.[0]?.productId;

            if (productId) {
              tx.update(
                db
                  .collection("products")
                  .doc(productId),
                {
                  status:
                    "available",

                  reservedOrderId:
                    null,

                  reservedAt:
                    null,

                  updatedAt:
                    now,
                }
              );
            }

            tx.update(
              orderRef,
              {
                status:
                  "REFUNDED",

                refundReason:
                  "SELLER_REJECTED",

                refundedAt:
                  now,

                updatedAt:
                  now,
              }
            );

            createFinancialTransaction(
              tx,
              {
                userId:
                  d.buyerId,

                orderId:
                  orderDoc.id,

                type:
                  "purchase_refund",

                amount:
                  total,

                currency:
                  d.currency,

                description:
                  "Refund after seller rejection",

                status:
                  "completed",
              }
            );

            createFinancialTransaction(
              tx,
              {
                userId:
                  d.sellerId,

                orderId:
                  orderDoc.id,

                type:
                  "sale_cancelled",

                amount:
                  -total,

                currency:
                  d.currency,

                description:
                  "Pending sale cancelled",

                status:
                  "cancelled",
              }
            );

            createNotification(
              tx,
              d.buyerId,
              "ORDER_REFUNDED",
              "تم رد المبلغ",
              "رفض البائع الطلب وتمت إعادة المبلغ إلى رصيدك.",
              orderDoc.id,
              pushQueue
            );

            return {
              ...d,

              status:
                "REFUNDED",

              refundedAt:
                now,

              updatedAt:
                now,
            };
          }
        );

      await sendPushBatch(pushQueue);

      res.json(
        toOrderDto(
          req.params.id,
          result
        )
      );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * SELLER DELIVER
 *
 * POST /orders/:id/deliver
 *
 * البائع فقط، وبعد ما يكون وافق على الطلب.
 * لا ينقل أي فلوس، فقط يغيّر حالة الطلب
 * ويبلّغ المشتري إنه يقدر يبدأ يختبر الحساب.
 * =========================================================
 */

router.post(
  "/:id/deliver",
  async (req, res, next) => {
    try {
      const orderRef = db
        .collection("orders")
        .doc(req.params.id);

      const pushQueue: PushItem[] = [];

      const result = await db.runTransaction(
        async (tx) => {
          pushQueue.length = 0;

          const orderDoc = await tx.get(orderRef);

          if (!orderDoc.exists) {
            throw Errors.notFound("Order");
          }

          const d = orderDoc.data()!;

          if (d.sellerId !== req.userId) {
            throw Errors.forbidden(
              "Only the seller can deliver this order"
            );
          }

          if (
            d.status !== "SELLER_ACCEPTED" &&
            d.status !== "CHAT_ACTIVE"
          ) {
            throw Errors.conflict(
              "Order is not ready for delivery"
            );
          }

          const now = nowIso();

          /*
           * كل القراءات قبل أي كتابة.
           */
          const conversationRef = d.conversationId
            ? db
                .collection("conversations")
                .doc(d.conversationId)
            : null;

          const conversationDoc = conversationRef
            ? await tx.get(conversationRef)
            : null;

          tx.update(orderRef, {
            status: "ACCOUNT_DELIVERED",
            deliveredAt: now,
            buyerTestingStartedAt: now,
            updatedAt: now,
          });

          if (conversationRef && conversationDoc?.exists) {
            tx.update(conversationRef, {
              lastMessage:
                "قام البائع بتسليم بيانات الحساب.",
              lastMessageAt: now,
              updatedAt: now,
            });

            const messageRef = conversationRef
              .collection("messages")
              .doc(uuid());

            tx.set(messageRef, {
              conversationId: d.conversationId,
              senderId: req.userId,
              text:
                "تم تسليم بيانات الحساب. يرجى اختباره ثم تأكيد الاستلام أو فتح نزاع.",
              createdAt: now,
              status: "sent",
              system: true,
            });
          }

          createNotification(
            tx,
            d.buyerId,
            "ORDER_ACCOUNT_DELIVERED",
            "تم تسليم الحساب",
            "قام البائع بتسليم بيانات الحساب، يرجى اختباره ثم تأكيد الاستلام.",
            orderDoc.id,
            pushQueue
          );

          return {
            ...d,
            status: "ACCOUNT_DELIVERED",
            deliveredAt: now,
            buyerTestingStartedAt: now,
            updatedAt: now,
          };
        }
      );

      await sendPushBatch(pushQueue);

      res.json(
        toOrderDto(req.params.id, result)
      );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * BUYER CONFIRM
 *
 * POST /orders/:id/confirm
 *
 * المشتري فقط. بيحرر الفلوس من الـescrow
 * (heldBalance عند المشتري) وينقلها لرصيد
 * البائع القابل للاستخدام (balance)، بعد ما
 * كانت pendingBalance فقط.
 * =========================================================
 */

router.post(
  "/:id/confirm",
  async (req, res, next) => {
    try {
      const orderRef = db
        .collection("orders")
        .doc(req.params.id);

      const pushQueue: PushItem[] = [];

      const result = await db.runTransaction(
        async (tx) => {
          pushQueue.length = 0;

          const orderDoc = await tx.get(orderRef);

          if (!orderDoc.exists) {
            throw Errors.notFound("Order");
          }

          const d = orderDoc.data()!;

          if (d.buyerId !== req.userId) {
            throw Errors.forbidden(
              "Only the buyer can confirm this order"
            );
          }

          if (
            d.status !== "ACCOUNT_DELIVERED" &&
            d.status !== "BUYER_TESTING"
          ) {
            throw Errors.conflict(
              "Order cannot be confirmed in its current state"
            );
          }

          const buyerWalletRef = db
            .collection("wallets")
            .doc(d.buyerId);

          const sellerWalletRef = db
            .collection("wallets")
            .doc(d.sellerId);

          const [buyerWalletDoc, sellerWalletDoc] =
            await Promise.all([
              tx.get(buyerWalletRef),
              tx.get(sellerWalletRef),
            ]);

          const buyerWallet = buyerWalletDoc.exists
            ? buyerWalletDoc.data()!
            : {};

          const sellerWallet = sellerWalletDoc.exists
            ? sellerWalletDoc.data()!
            : {};

          const buyerHeld = Number(
            buyerWallet.heldBalance ?? 0
          );

          const sellerPending = Number(
            sellerWallet.pendingBalance ?? 0
          );

          const sellerBalance = Number(
            sellerWallet.balance ?? 0
          );

          const total = Number(d.total);
          const now = nowIso();

          /*
           * الفلوس خرجت من balance المشتري
           * وقت الشراء، فمش هنلمسها تاني.
           * بس بنقفل الـhold بتاعها.
           */
          tx.set(
            buyerWalletRef,
            {
              heldBalance: Math.max(
                0,
                buyerHeld - total
              ),
              updatedAt: now,
            },
            { merge: true }
          );

          /*
           * تحويل الفلوس من pendingBalance
           * إلى balance القابل للسحب عند البائع.
           */
          tx.set(
            sellerWalletRef,
            {
              pendingBalance: Math.max(
                0,
                sellerPending - total
              ),
              balance: sellerBalance + total,
              currency:
                sellerWallet.currency || d.currency,
              updatedAt: now,
            },
            { merge: true }
          );

          const productId =
            d.productId || d.items?.[0]?.productId;

          if (productId) {
            tx.update(
              db.collection("products").doc(productId),
              {
                status: "sold",
                reservedOrderId: null,
                updatedAt: now,
              }
            );
          }

          tx.update(orderRef, {
            status: "COMPLETED",
            completedAt: now,
            updatedAt: now,
          });

          createFinancialTransaction(tx, {
            userId: d.buyerId,
            orderId: orderDoc.id,
            type: "purchase_completed",
            amount: 0,
            currency: d.currency,
            description:
              "Order completed - held funds released",
            status: "completed",
          });

          createFinancialTransaction(tx, {
            userId: d.sellerId,
            orderId: orderDoc.id,
            type: "sale_completed",
            amount: total,
            currency: d.currency,
            description:
              "Sale completed - funds released to balance",
            status: "completed",
          });

          createNotification(
            tx,
            d.sellerId,
            "ORDER_COMPLETED",
            "تم تأكيد الاستلام",
            "قام المشتري بتأكيد استلام الحساب، وتم تحويل المبلغ إلى رصيدك.",
            orderDoc.id,
            pushQueue
          );

          return {
            ...d,
            status: "COMPLETED",
            completedAt: now,
            updatedAt: now,
          };
        }
      );

      await sendPushBatch(pushQueue);

      res.json(
        toOrderDto(req.params.id, result)
      );
    } catch (err) {
      next(err);
    }
  }
);

/*
 * =========================================================
 * BUYER DISPUTE
 *
 * POST /orders/:id/dispute
 *
 * المشتري فقط. لا يتم تحويل أي فلوس تلقائيًا؛
 * الفلوس تفضل held/pending لحد ما النزاع يتحل
 * (يدويًا من الأدمن، خارج نطاق هذا الملف).
 * =========================================================
 */

router.post(
  "/:id/dispute",
  async (req, res, next) => {
    try {
      const orderRef = db
        .collection("orders")
        .doc(req.params.id);

      const rawReason = req.body?.reason;

      const reason =
        typeof rawReason === "string" &&
        rawReason.trim().length > 0
          ? rawReason.trim().slice(0, 1000)
          : null;

      const pushQueue: PushItem[] = [];

      const result = await db.runTransaction(
        async (tx) => {
          pushQueue.length = 0;

          const orderDoc = await tx.get(orderRef);

          if (!orderDoc.exists) {
            throw Errors.notFound("Order");
          }

          const d = orderDoc.data()!;

          if (d.buyerId !== req.userId) {
            throw Errors.forbidden(
              "Only the buyer can dispute this order"
            );
          }

          if (
            d.status !== "ACCOUNT_DELIVERED" &&
            d.status !== "BUYER_TESTING"
          ) {
            throw Errors.conflict(
              "Order cannot be disputed in its current state"
            );
          }

          const now = nowIso();

          tx.update(orderRef, {
            status: "DISPUTED",
            disputedAt: now,
            disputeReason: reason,
            updatedAt: now,
          });

          createNotification(
            tx,
            d.sellerId,
            "ORDER_DISPUTED",
            "تم فتح نزاع",
            "قام المشتري بفتح نزاع على الطلب. لن يتم تحويل المبلغ حتى يتم حل النزاع.",
            orderDoc.id,
            pushQueue
          );

          return {
            ...d,
            status: "DISPUTED",
            disputedAt: now,
            disputeReason: reason,
            updatedAt: now,
          };
        }
      );

      await sendPushBatch(pushQueue);

      res.json(
        toOrderDto(req.params.id, result)
      );
    } catch (err) {
      next(err);
    }
  }
);

export default router;
