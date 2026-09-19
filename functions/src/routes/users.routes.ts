import { Router } from "express";
import { db, FieldValue } from "../firebase";
import { requireAuth } from "../middleware/auth";
import { getMe, toUserDto } from "./auth.routes";

const router = Router();

// GET /users/me
router.get("/me", requireAuth, getMe);

// POST /users/sync
// Creates or updates the Gameora profile for the authenticated Firebase user.
router.post("/sync", requireAuth, async (req, res, next) => {
  try {
    const uid = req.userId;

    if (!uid) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const {
      username,
      email,
      displayName,
      avatarUrl,
    } = req.body || {};

    if (!username || !email) {
      return res.status(400).json({
        message: "username and email are required",
      });
    }

    const userRef = db.collection("users").doc(uid);
    const existing = await userRef.get();

    const now = new Date().toISOString();

    if (!existing.exists) {
      const userData = {
        username: String(username).trim(),
        email: String(email).trim().toLowerCase(),
        displayName:
          String(displayName || username).trim() ||
          String(username).trim(),
        avatarUrl: avatarUrl || null,
        rating: 0,
        reviewsCount: 0,
        verified: false,
        isSeller: false,
        createdAt: now,
        updatedAt: now,
      };

      await userRef.set(userData);

      const walletRef = db.collection("wallets").doc(uid);
      const wallet = await walletRef.get();

      if (!wallet.exists) {
        await walletRef.set({
          balance: 0,
          currency: "USD",
          pendingBalance: 0,
        });
      }

      return res.status(201).json(
        toUserDto(uid, userData)
      );
    }

    const currentData = existing.data() || {};

    const updates = {
      email: String(email).trim().toLowerCase(),
      displayName:
        String(displayName || currentData.displayName || username).trim(),
      avatarUrl: avatarUrl || currentData.avatarUrl || null,
      updatedAt: now,
    };

    await userRef.update(updates);

    const walletRef = db.collection("wallets").doc(uid);
    const wallet = await walletRef.get();

    if (!wallet.exists) {
      await walletRef.set({
        balance: 0,
        currency: "USD",
        pendingBalance: 0,
      });
    }

    return res.json(
      toUserDto(uid, {
        ...currentData,
        ...updates,
      })
    );
  } catch (err) {
    next(err);
  }
});

// POST /users/me/fcm-token
// يسجّل device token بتاع FCM للمستخدم الحالي عشان الباكيند
// يقدر يبعتله Push Notifications حقيقية حتى لو التطبيق مقفول.
// بنستخدم arrayUnion عشان مستخدم واحد ممكن يكون عنده أكتر من جهاز.
router.post("/me/fcm-token", requireAuth, async (req, res, next) => {
  try {
    const uid = req.userId;

    if (!uid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = req.body?.token;

    if (typeof token !== "string" || token.trim().length === 0) {
      return res.status(400).json({ message: "token is required" });
    }

    await db
      .collection("users")
      .doc(uid)
      .set(
        {
          fcmTokens: FieldValue.arrayUnion(token.trim()),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// DELETE /users/me/fcm-token
// بيشيل الـ token ده من المستخدم (مثلاً عند تسجيل الخروج) عشان
// الجهاز ده ميستقبلش إشعارات لمستخدم مش هو اللي مسجل دخول عليه.
router.delete("/me/fcm-token", requireAuth, async (req, res, next) => {
  try {
    const uid = req.userId;

    if (!uid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = req.body?.token;

    if (typeof token !== "string" || token.trim().length === 0) {
      return res.status(400).json({ message: "token is required" });
    }

    await db
      .collection("users")
      .doc(uid)
      .set(
        {
          fcmTokens: FieldValue.arrayRemove(token.trim()),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
