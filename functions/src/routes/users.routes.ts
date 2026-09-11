import { Router } from "express";
import { db } from "../firebase";
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

export default router;
