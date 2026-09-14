import { Router } from "express";
import { db } from "../firebase";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";

const router = Router();

router.use(requireAuth);

const PAYMOB_BASE_URL = "https://accept.paymob.com";
const PAYMOB_CHECKOUT_URL =
  "https://accept.paymob.com/unifiedcheckout/";

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
          currency: "EGP",
          pendingBalance: 0,
        };

    res.json({
      balance: d.balance ?? 0,
      currency: d.currency ?? "EGP",
      pendingBalance: d.pendingBalance ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /wallet/deposit/create
 *
 * Creates a pending deposit and a Paymob payment intention.
 *
 * IMPORTANT:
 * The wallet is NOT credited here.
 * Wallet credit will happen only after the Paymob
 * transaction callback confirms a successful payment.
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
        message: "Minimum deposit amount is 10 EGP",
      });
    }

    if (amount > 100000) {
      return res.status(400).json({
        message: "Maximum deposit amount is 100000 EGP",
      });
    }

    if (currency !== "EGP") {
      return res.status(400).json({
        message: "Only EGP deposits are currently supported",
      });
    }

    const secretKey = process.env.PAYMOB_SECRET_KEY;
    const integrationId =
      process.env.PAYMOB_INTEGRATION_ID;

    if (!secretKey) {
      return res.status(500).json({
        message: "Paymob secret key is not configured",
        code: "paymob_secret_missing",
      });
    }

    if (!integrationId) {
      return res.status(500).json({
        message: "Paymob integration ID is not configured",
        code: "paymob_integration_missing",
      });
    }

    const parsedIntegrationId = Number(integrationId);

    if (
      !Number.isInteger(parsedIntegrationId) ||
      parsedIntegrationId <= 0
    ) {
      return res.status(500).json({
        message: "Invalid Paymob integration ID",
        code: "paymob_integration_invalid",
      });
    }

    const depositRef = db
      .collection("deposits")
      .doc();

    const transactionRef = db
      .collection("transactions")
      .doc();

    const now = new Date();

    /*
     * Store the deposit first.
     * It remains PENDING until Paymob confirms payment.
     */
    await db.runTransaction(async (transaction) => {
      transaction.set(depositRef, {
        id: depositRef.id,
        userId,
        amount,
        currency,
        status: "PENDING",
        provider: "PAYMOB",
        providerPaymentId: null,
        providerOrderId: null,
        intentionId: null,
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
        provider: "PAYMOB",
        depositId: depositRef.id,
        createdAt: now,
      });
    });

    const amountCents = Math.round(amount * 100);

    /*
     * Paymob callbacks are sent to this public endpoint.
     */
    const notificationUrl =
      "https://gameora-backend6-11an.vercel.app/payments/paymob/webhook";

    /*
     * This URL is only for the customer's browser/app
     * after Paymob finishes the checkout.
     *
     * It is NOT used as proof of payment.
     */
    const redirectionUrl =
      "https://gameora-backend6-11an.vercel.app/wallet/payment-result";

    const intentionPayload = {
      amount: amountCents,
      currency: "EGP",

      payment_methods: [
        parsedIntegrationId,
      ],

      items: [
        {
          name: "Gameora Wallet Deposit",
          amount: amountCents,
          description: `إضافة رصيد إلى محفظة Gameora`,
          quantity: 1,
        },
      ],

      billing_data: {
        apartment: "NA",
        first_name: "Gameora",
        last_name: "User",
        street: "NA",
        building: "NA",
        phone_number: "+201000000000",
        city: "Cairo",
        country: "EG",
        email: "customer@gameora.app",
        floor: "NA",
        state: "Cairo",
      },

      extras: {
        gameora_deposit_id: depositRef.id,
        gameora_user_id: userId,
      },

      special_reference: depositRef.id,

      expiration: 3600,

      notification_url: notificationUrl,

      redirection_url: redirectionUrl,
    };

    const paymobResponse = await fetch(
      `${PAYMOB_BASE_URL}/v1/intention/`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(intentionPayload),
      }
    );

    const paymobData: any =
      await paymobResponse.json();

    if (!paymobResponse.ok) {
      console.error(
        "Paymob intention creation failed:",
        paymobData
      );

      await db.runTransaction(async (transaction) => {
        transaction.update(depositRef, {
          status: "FAILED",
          updatedAt: new Date(),
          failureReason: "PAYMOB_INTENTION_FAILED",
        });

        transaction.update(transactionRef, {
          status: "FAILED",
        });
      });

      return res.status(502).json({
        message: "Unable to create Paymob payment",
        code: "paymob_intention_failed",
      });
    }

    const intentionId =
      paymobData?.id ?? null;

    const paymobOrderId =
      paymobData?.intention_order_id ??
      paymobData?.payment_keys?.[0]?.order_id ??
      null;

    const clientSecret =
      paymobData?.client_secret ?? null;

    if (!intentionId || !clientSecret) {
      console.error(
        "Invalid Paymob intention response:",
        paymobData
      );

      await db.runTransaction(async (transaction) => {
        transaction.update(depositRef, {
          status: "FAILED",
          updatedAt: new Date(),
          failureReason: "INVALID_PAYMOB_RESPONSE",
        });

        transaction.update(transactionRef, {
          status: "FAILED",
        });
      });

      return res.status(502).json({
        message: "Invalid payment response from Paymob",
        code: "paymob_invalid_response",
      });
    }

    await db.runTransaction(async (transaction) => {
      transaction.update(depositRef, {
        intentionId,
        providerOrderId: paymobOrderId,
        clientSecret,
        updatedAt: new Date(),
      });

      transaction.update(transactionRef, {
        providerPaymentId: intentionId,
        providerOrderId: paymobOrderId,
      });
    });

    /*
     * The client_secret is generated by Paymob and is
     * required to launch Unified Checkout.
     */
    const paymentUrl =
      `${PAYMOB_CHECKOUT_URL}?publicKey=` +
      encodeURIComponent(
        process.env.PAYMOB_PUBLIC_KEY ?? ""
      ) +
      `&clientSecret=` +
      encodeURIComponent(clientSecret);

    return res.status(201).json({
      depositId: depositRef.id,
      amount,
      currency,
      status: "PENDING",
      intentionId,
      paymentUrl,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /wallet/transactions
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
