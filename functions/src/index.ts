import express, {
  NextFunction,
  Request,
  Response,
} from "express";
import cors from "cors";
import path from "path";
import { ApiError } from "./lib/errors";
import { db } from "./firebase";

import authRoutes from "./routes/auth.routes";
import usersRoutes from "./routes/users.routes";
import gamesRoutes from "./routes/games.routes";
import categoriesRoutes from "./routes/categories.routes";
import productsRoutes from "./routes/products.routes";
import sellersRoutes from "./routes/sellers.routes";
import reviewsRoutes from "./routes/reviews.routes";
import ordersRoutes from "./routes/orders.routes";
import walletRoutes from "./routes/wallet.routes";
import chatRoutes from "./routes/chat.routes";
import notificationsRoutes from "./routes/notifications.routes";
import adminRoutes from "./routes/admin.routes";
import offersRoutes from "./routes/offers.routes";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// تقديم صفحات الموقع الموجودة داخل public
app.use(express.static(path.join(__dirname, "../public")));

// API Routes
app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/games", gamesRoutes);
app.use("/categories", categoriesRoutes);
app.use("/products", productsRoutes);
app.use("/sellers", sellersRoutes);
app.use("/reviews", reviewsRoutes);
app.use("/orders", ordersRoutes);
app.use("/wallet", walletRoutes);
app.use("/conversations", chatRoutes);
app.use("/notifications", notificationsRoutes);

// Admin API
app.use("/admin", adminRoutes);

// Public Offers API
app.use("/offers", offersRoutes);

/*
 * Paymob Transaction Webhook
 *
 * مهم:
 * - Public endpoint
 * - لا يحتاج Firebase Authentication
 * - لا نضيف الرصيد بمجرد رجوع المستخدم من صفحة الدفع
 * - Paymob Callback هو مصدر الحقيقة
 *
 * HMAC verification سيتم تفعيله قبل السماح
 * بإضافة الرصيد.
 */
app.post(
  "/payments/paymob/webhook",
  async (req: Request, res: Response) => {
    try {
      const payload = req.body;

      if (!payload || typeof payload !== "object") {
        return res.status(400).json({
          ok: false,
          message: "Invalid webhook payload",
        });
      }

      const transaction = payload?.obj;

      if (!transaction) {
        return res.status(400).json({
          ok: false,
          message: "Missing transaction object",
        });
      }

      const transactionId = transaction?.id;

      const success = transaction?.success === true;

      const amountCents = Number(
        transaction?.amount_cents
      );

      const currency = transaction?.currency;

      const integrationId = Number(
        transaction?.integration_id
      );

      const orderId = Number(
        transaction?.order?.id
      );

      if (!transactionId) {
        return res.status(400).json({
          ok: false,
          message: "Missing transaction id",
        });
      }

      /*
       * نحن لا نثق في callback وحده لإضافة الرصيد
       * قبل التحقق من HMAC.
       *
       * لذلك في هذه المرحلة نرفض أي callback
       * إذا لم يكن HMAC موجودًا.
       */
      const receivedHmac =
        typeof payload?.hmac === "string"
          ? payload.hmac
          : typeof transaction?.hmac === "string"
            ? transaction.hmac
            : null;

      if (!receivedHmac) {
        console.error(
          "Paymob webhook rejected: missing HMAC",
          {
            transactionId,
          }
        );

        return res.status(401).json({
          ok: false,
          message: "Missing HMAC",
        });
      }

      /*
       * TODO:
       *
       * هنا سنضع حساب HMAC الرسمي الخاص بـ
       * Transaction Processed Callback بعد تثبيت
       * قائمة الحقول الرسمية من Paymob.
       *
       * لا نضيف الرصيد قبل هذه الخطوة.
       */
      return res.status(501).json({
        ok: false,
        message: "Webhook HMAC verification is not configured yet",
        transactionId,
        success,
        amountCents,
        currency,
        integrationId,
        orderId,
      });
    } catch (error) {
      console.error(
        "Paymob webhook error:",
        error
      );

      return res.status(500).json({
        ok: false,
        message: "Webhook processing failed",
      });
    }
  }
);

/*
 * Payment result page
 *
 * Paymob redirects the customer here after checkout.
 * This endpoint is for UX only.
 *
 * The payment status must still be determined
 * from the Paymob transaction webhook.
 */
app.get(
  "/wallet/payment-result",
  (_req: Request, res: Response) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
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
              text-align: center;
            }

            .box {
              width: min(90%, 420px);
              padding: 32px 24px;
              background: #0D1B2A;
              border-radius: 20px;
              box-sizing: border-box;
            }

            h1 {
              margin-top: 0;
            }

            p {
              color: #A8B6C7;
              line-height: 1.8;
            }
          </style>
        </head>

        <body>
          <div class="box">
            <h1>تم استلام نتيجة الدفع</h1>
            <p>
              جاري التحقق من حالة العملية.
              سيتم تحديث رصيد Gameora بعد تأكيد الدفع
              من Paymob.
            </p>
          </div>
        </body>
      </html>
    `);
  }
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "gameora-api",
  });
});

// 404
app.use((_req, res) => {
  res.status(404).json({
    message: "Not found",
    error: "not_found",
    code: "not_found",
  });
});

// Error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(
  (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        message: err.message,
        error: err.code,
        code: err.code,
      });
    }

    console.error(
      "Unhandled error:",
      err
    );

    res.status(500).json({
      message: "Internal server error",
      error: "internal_error",
      code: "internal_error",
    });
  }
);

export default app;
