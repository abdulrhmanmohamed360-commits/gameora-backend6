import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import path from "path";
import { ApiError } from "./lib/errors";

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
// التطبيق يستخدم هذا المسار لقراءة العروض من السيرفر
app.use("/offers", offersRoutes);

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

    console.error("Unhandled error:", err);

    res.status(500).json({
      message: "Internal server error",
      error: "internal_error",
      code: "internal_error",
    });
  }
);

export default app;
