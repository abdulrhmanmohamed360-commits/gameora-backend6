import { Router } from "express";
import { db } from "../firebase";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";

const router = Router();

router.use(requireAuth);

function toTransactionDto(
  id: string,
  d: FirebaseFirestore.DocumentData
) {
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

/**
 * GET /wallet
 *
 * Returns the authenticated user's wallet.
 */
router.get("/", async (req, res, next) => {
  try {
    const doc = await db
      .collection("wallets")
      .doc(req.userId!)
      .get();

    const d = doc.exists
      ? doc.data()!
      : {
          balance: 0,
          currency: "USD",
          pendingBalance: 0,
        };

    res.json({
      balance: d.balance ?? 0,
      currency: d.currency ?? "USD",
      pendingBalance: d.pendingBalance ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /wallet/deposit/create
 *
 * Creates a pending deposit request.
 *
 * IMPORTANT:
 * This endpoint does NOT add money to the wallet.
 * The actual wallet credit must happen only after
 * the payment provider confirms the payment.
 */
router.post("/deposit/create", async (req, res, next) => {
  try {
    const userId = req.userId!;

    const rawAmount = req.body?.amount;
    const currency =
      typeof req.body?.currency === "string"
        ? req.body.currency.toUpperCase()
        : "EGP";

    const amount = Number(rawAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        message: "Invalid amount",
      });
    }

    if (amount < 10) {
      return res.status(400).json({
        message: "Minimum deposit amount is 10",
      });
    }

    if (amount > 100000) {
      return res.status(400).json({
        message: "Maximum deposit amount is 100000",
      });
    }

    const allowedCurrencies = [
      "EGP",
      "USD",
      "SAR",
      "AED",
      "EUR",
    ];

    if (!allowedCurrencies.includes(currency)) {
      return res.status(400).json({
        message: "Unsupported currency",
      });
    }

    const depositRef = db
      .collection("deposits")
      .doc();

    const transactionRef = db
      .collection("transactions")
      .doc();

    const now = new Date();

    await db.runTransaction(async (transaction) => {
      transaction.set(depositRef, {
        id: depositRef.id,
        userId,
        amount,
        currency,
        status: "PENDING",
        provider: null,
        providerPaymentId: null,
        createdAt: now,
        updatedAt: now,
      });

      transaction.set(transactionRef, {
        id: transactionRef.id,
        userId,
        type: "DEPOSIT",
        amount,
        currency,
        description: "إضافة رصيد",
        status: "PENDING",
        depositId: depositRef.id,
        createdAt: now,
      });
    });

    /*
     * لا نرجع أي قيمة تدل أن الدفع تم.
     *
     * في الخطوة القادمة سيتم إنشاء عملية الدفع
     * من خلال بوابة الدفع الحقيقية هنا.
     */
    return res.status(201).json({
      depositId: depositRef.id,
      amount,
      currency,
      status: "PENDING",
      paymentUrl: null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /wallet/transactions
 *
 * Returns wallet transaction history.
 */
router.get("/transactions", async (req, res, next) => {
  try {
    const snap = await db
      .collection("transactions")
      .where("userId", "==", req.userId)
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();

    const items = snap.docs.map((d) =>
      toTransactionDto(d.id, d.data())
    );

    const { page, limit } =
      parsePageParams(req.query as any);

    const start = (page - 1) * limit;

    res.json(
      buildPaginatedResponse(
        items.slice(start, start + limit),
        items.length,
        page,
        limit
      )
    );
  } catch (err) {
    next(err);
  }
});

export default router;
