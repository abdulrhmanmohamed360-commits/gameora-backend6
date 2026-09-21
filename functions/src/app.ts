import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { ApiError } from "./lib/errors";
import { db } from "./firebase";

import authRoutes from "./routes/auth.routes";
import usersRoutes from "./routes/users.routes";
import gamesRoutes from "./routes/games.routes";
import categoriesRoutes from "./routes/categories.routes";
import productsRoutes from "./routes/products.routes";
import sellersRoutes from "./routes/sellers.routes";
import reviewsRoutes from "./routes/reviews.routes";
import walletRoutes from "./routes/wallet.routes";
import chatRoutes from "./routes/chat.routes";
import notificationsRoutes from "./routes/notifications.routes";
import adminRoutes from "./routes/admin.routes";
import adminManageRoutes from "./routes/admin.manage.routes";
import offersRoutes from "./routes/offers.routes";
import ordersRoutes from "./routes/orders.routes";
import supportRoutes from "./routes/support.routes";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "../public")));

/*
 * =========================================================
 * PAYMOB HELPERS
 * =========================================================
 */

function calculatePaymobHmac(
  obj: any,
  secret: string
): string {
  const values = [
    obj?.amount_cents,
    obj?.created_at,
    obj?.currency,
    obj?.error_occured,
    obj?.has_parent_transaction,
    obj?.id,
    obj?.integration_id,
    obj?.is_3d_secure,
    obj?.is_auth,
    obj?.is_capture,
    obj?.is_refunded,
    obj?.is_standalone_payment,
    obj?.is_voided,
    obj?.order?.id,
    obj?.owner,
    obj?.pending,
    obj?.source_data?.pan,
    obj?.source_data?.sub_type,
    obj?.source_data?.type,
    obj?.success,
  ];

  const data = values
    .map((value) =>
      value === null || value === undefined
        ? ""
        : String(value)
    )
    .join("");

  return crypto
    .createHmac("sha512", secret)
    .update(data)
    .digest("hex");
}

function isValidHmac(
  calculated: string,
  received: string
): boolean {
  const calculatedBuffer =
    Buffer.from(calculated, "utf8");

  const receivedBuffer =
    Buffer.from(received, "utf8");

  if (
    calculatedBuffer.length !==
    receivedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    calculatedBuffer,
    receivedBuffer
  );
}

/*
 * =========================================================
 * PUBLIC PAYMOB WEBHOOK
 *
 * مهم:
 * هذا المسار Public ولا يستخدم Firebase Bearer Token.
 * Paymob هو الذي يستدعيه.
 * =========================================================
 */

app.post(
  "/payments/paymob/webhook",
  async (
    req: Request,
    res: Response
  ) => {
    try {
      const payload = req.body;
      const obj = payload?.obj;

      if (!obj) {
        return res.status(400).json({
          ok: false,
          message:
            "Missing Paymob transaction object",
        });
      }

      const receivedHmac =
        typeof payload?.hmac === "string"
          ? payload.hmac
          : typeof req.query?.hmac === "string"
            ? req.query.hmac
            : null;

      if (!receivedHmac) {
        console.error(
          "Paymob webhook rejected: missing HMAC"
        );

        return res.status(401).json({
          ok: false,
          message: "Missing HMAC",
        });
      }

      const hmacSecret =
        process.env.PAYMOB_HMAC_SECRET;

      if (!hmacSecret) {
        console.error(
          "PAYMOB_HMAC_SECRET is not configured"
        );

        return res.status(500).json({
          ok: false,
          message:
            "Paymob HMAC secret is not configured",
        });
      }

      const calculatedHmac =
        calculatePaymobHmac(
          obj,
          hmacSecret
        );

      if (
        !isValidHmac(
          calculatedHmac,
          receivedHmac
        )
      ) {
        console.error(
          "Paymob webhook rejected: invalid HMAC",
          {
            transactionId:
              obj?.id ?? null,
          }
        );

        return res.status(401).json({
          ok: false,
          message: "Invalid HMAC",
        });
      }

      const transactionId =
        Number(obj?.id);

      const amountCents =
        Number(obj?.amount_cents);

      const currency =
        typeof obj?.currency === "string"
          ? obj.currency.toUpperCase()
          : "";

      const integrationId =
        Number(obj?.integration_id);

      const orderId =
        Number(obj?.order?.id);

      const success =
        obj?.success === true;

      if (
        !Number.isFinite(transactionId) ||
        transactionId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid Paymob transaction ID",
        });
      }

      if (
        !Number.isFinite(amountCents) ||
        amountCents <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid Paymob amount",
        });
      }

      if (currency !== "EGP") {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid payment currency",
        });
      }

      const configuredIntegrationId =
        Number(
          process.env.PAYMOB_INTEGRATION_ID
        );

      if (
        !Number.isFinite(
          configuredIntegrationId
        ) ||
        configuredIntegrationId <= 0
      ) {
        return res.status(500).json({
          ok: false,
          message:
            "Paymob integration ID is not configured",
        });
      }

      if (
        integrationId !==
        configuredIntegrationId
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid Paymob integration ID",
        });
      }

      if (
        !Number.isFinite(orderId) ||
        orderId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid Paymob order ID",
        });
      }

      /*
       * Find the Gameora deposit using
       * the Paymob order ID.
       */
      const depositSnapshot =
        await db
          .collection("deposits")
          .where(
            "providerOrderId",
            "==",
            orderId
          )
          .limit(1)
          .get();

      if (depositSnapshot.empty) {
        console.error(
          "Paymob webhook: deposit not found",
          {
            orderId,
            transactionId,
          }
        );

        return res.status(404).json({
          ok: false,
          message: "Deposit not found",
        });
      }

      const depositDoc =
        depositSnapshot.docs[0];

      const depositRef =
        depositDoc.ref;

      const transactionSnapshot =
        await db
          .collection("transactions")
          .where(
            "depositId",
            "==",
            depositRef.id
          )
          .limit(1)
          .get();

      if (transactionSnapshot.empty) {
        console.error(
          "Paymob webhook: Gameora transaction not found",
          {
            depositId:
              depositRef.id,
          }
        );

        return res.status(404).json({
          ok: false,
          message:
            "Gameora transaction not found",
        });
      }

      const gameoraTransactionRef =
        transactionSnapshot.docs[0].ref;

      const result =
        await db.runTransaction(
          async (transaction) => {
            const freshDeposit =
              await transaction.get(
                depositRef
              );

            if (!freshDeposit.exists) {
              throw new Error(
                "Deposit no longer exists"
              );
            }

            const depositData =
              freshDeposit.data()!;

            /*
             * Prevent duplicate Paymob callbacks
             * from adding the money twice.
             */
            if (
              depositData.status ===
              "COMPLETED"
            ) {
              return {
                alreadyCompleted: true,
                userId:
                  depositData.userId,
                amount:
                  depositData.amount,
              };
            }

            const freshWallet =
              await transaction.get(
                db
                  .collection("wallets")
                  .doc(
                    depositData.userId
                  )
              );

            const freshGameoraTransaction =
              await transaction.get(
                gameoraTransactionRef
              );

            const expectedAmountCents =
              Math.round(
                Number(
                  depositData.amount
                ) * 100
              );

            if (
              expectedAmountCents !==
              amountCents
            ) {
              throw new Error(
                "Payment amount does not match deposit"
              );
            }

            if (
              depositData.currency !==
              currency
            ) {
              throw new Error(
                "Payment currency does not match deposit"
              );
            }

            const userId =
              depositData.userId;

            if (!userId) {
              throw new Error(
                "Deposit has no user ID"
              );
            }

            /*
             * Payment failed.
             * Do NOT add money.
             */
            if (!success) {
              transaction.update(
                depositRef,
                {
                  status: "FAILED",
                  providerPaymentId:
                    String(
                      transactionId
                    ),
                  updatedAt:
                    new Date(),
                }
              );

              if (
                freshGameoraTransaction.exists
              ) {
                transaction.update(
                  gameoraTransactionRef,
                  {
                    status: "FAILED",
                    providerPaymentId:
                      String(
                        transactionId
                      ),
                    updatedAt:
                      new Date(),
                  }
                );
              }

              return {
                alreadyCompleted: false,
                failed: true,
                userId,
              };
            }

            const walletRef =
              db
                .collection("wallets")
                .doc(userId);

            const currentWallet =
              freshWallet.exists
                ? freshWallet.data()!
                : {};

            const currentBalance =
              Number(
                currentWallet.balance ?? 0
              );

            const depositAmount =
              Number(
                depositData.amount
              );

            const newBalance =
              currentBalance +
              depositAmount;

            /*
             * CREDIT WALLET ONLY HERE.
             *
             * This happens only after:
             * - valid HMAC
             * - matching integration
             * - matching order
             * - matching amount
             * - successful Paymob payment
             */
            transaction.set(
              walletRef,
              {
                balance:
                  newBalance,
                currency:
                  "EGP",
                pendingBalance:
                  Number(
                    currentWallet.pendingBalance ??
                      0
                  ),
                updatedAt:
                  new Date(),
              },
              {
                merge: true,
              }
            );

            transaction.update(
              depositRef,
              {
                status:
                  "COMPLETED",
                providerPaymentId:
                  String(
                    transactionId
                  ),
                providerOrderId:
                  orderId,
                completedAt:
                  new Date(),
                updatedAt:
                  new Date(),
              }
            );

            if (
              freshGameoraTransaction.exists
            ) {
              transaction.update(
                gameoraTransactionRef,
                {
                  status:
                    "COMPLETED",
                  providerPaymentId:
                    String(
                      transactionId
                    ),
                  providerOrderId:
                    orderId,
                  updatedAt:
                    new Date(),
                }
              );
            }

            return {
              alreadyCompleted:
                false,
              failed: false,
              userId,
              amount:
                depositAmount,
              newBalance,
            };
          }
        );

      if (
        result.alreadyCompleted
      ) {
        return res.status(200).json({
          ok: true,
          received: true,
          alreadyProcessed:
            true,
        });
      }

      if (result.failed) {
        return res.status(200).json({
          ok: true,
          received: true,
          paymentSuccessful:
            false,
        });
      }

      return res.status(200).json({
        ok: true,
        received: true,
        paymentSuccessful:
          true,
        walletUpdated:
          true,
      });
    } catch (error) {
      console.error(
        "Paymob webhook processing error:",
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          "Webhook processing failed",
      });
    }
  }
);

/*
 * =========================================================
 * PUBLIC PAYMENT RESULT
 *
 * لازم يكون قبل walletRoutes لأن walletRoutes
 * يستخدم requireAuth.
 * =========================================================
 */

app.get(
  "/wallet/payment-result",
  (
    _req: Request,
    res: Response
  ) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
        <head>
          <meta charset="UTF-8">
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          >
          <title>Gameora - نتيجة الدفع</title>

          <style>
            body {
              margin: 0;
              background: #07111F;
              color: #FFFFFF;
              font-family: Arial, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
            }

            .box {
              width: 90%;
              max-width: 500px;
              background: #0D1B2A;
              border-radius: 18px;
              padding: 30px;
              text-align: center;
              box-sizing: border-box;
            }

            h1 {
              margin-top: 0;
              color: #38BDF8;
            }

            p {
              color: #A8B6C7;
              line-height: 1.8;
            }
          </style>
        </head>

        <body>
          <div class="box">
            <h1>
              تم استلام نتيجة الدفع
            </h1>

            <p>
              جاري التحقق من حالة العملية.
              سيتم تحديث رصيد Gameora بعد تأكيد
              الدفع من Paymob.
            </p>
          </div>
        </body>
      </html>
    `);
  }
);

/*
 * =========================================================
 * API ROUTES
 * =========================================================
 */

app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/games", gamesRoutes);
app.use("/categories", categoriesRoutes);
app.use("/products", productsRoutes);
app.use("/sellers", sellersRoutes);
app.use("/reviews", reviewsRoutes);
app.use("/orders", ordersRoutes);

/*
 * Wallet routes remain protected by
 * requireAuth inside wallet.routes.ts.
 *
 * Payment Result is already handled above,
 * so it won't reach requireAuth.
 */
app.use("/wallet", walletRoutes);

app.use("/conversations", chatRoutes);
app.use("/notifications", notificationsRoutes);
app.use("/support", supportRoutes);

app.use("/admin", adminRoutes);
app.use("/admin", adminManageRoutes);

app.use("/offers", offersRoutes);

/*
 * =========================================================
 * HEALTH
 * =========================================================
 */

app.get(
  "/health",
  (
    _req,
    res
  ) => {
    res.json({
      ok: true,
      service:
        "gameora-api",
    });
  }
);

/*
 * =========================================================
 * 404
 * =========================================================
 */

app.use(
  (
    _req,
    res
  ) => {
    res.status(404).json({
      message:
        "Not found",
      error:
        "not_found",
      code:
        "not_found",
    });
  }
);

/*
 * =========================================================
 * ERROR HANDLER
 * =========================================================
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(
  (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    if (
      err instanceof ApiError
    ) {
      return res.status(
        err.status
      ).json({
        message:
          err.message,
        error:
          err.code,
        code:
          err.code,
      });
    }

    console.error(
      "Unhandled error:",
      err
    );

    res.status(500).json({
      message:
        "Internal server error",
      error:
        "internal_error",
      code:
        "internal_error",
    });
  }
);

export default app;
