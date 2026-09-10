import { Router } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { signToken } from "../lib/jwt";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

const router = Router();

function toUserDto(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id,
    username: data.username ?? null,
    displayName: data.displayName ?? null,
    email: data.email ?? null,
    avatarUrl: data.avatarUrl ?? null,
    rating: data.rating ?? 0,
    reviewsCount: data.reviewsCount ?? 0,
    verified: data.verified ?? false,
    isSeller: data.isSeller ?? false,
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

// POST /auth/register
router.post("/register", async (req, res, next) => {
  try {
    const { username, email, password, displayName } = req.body || {};
    if (!username || !email || !password) {
      throw Errors.badRequest("username, email and password are required");
    }

    const usersRef = db.collection("users");
    const [byEmail, byUsername] = await Promise.all([
      usersRef.where("email", "==", email).limit(1).get(),
      usersRef.where("username", "==", username).limit(1).get(),
    ]);
    if (!byEmail.empty) throw Errors.conflict("Email already registered");
    if (!byUsername.empty) throw Errors.conflict("Username already taken");

    const now = new Date().toISOString();
    const id = uuid();
    const passwordHash = await bcrypt.hash(password, 10);

    const userData = {
      username,
      email,
      passwordHash,
      displayName: displayName || username,
      avatarUrl: null,
      rating: 0,
      reviewsCount: 0,
      verified: false,
      isSeller: false,
      createdAt: now,
      updatedAt: now,
    };

    await usersRef.doc(id).set(userData);
    // كل مستخدم جديد بياخد محفظة فاضية أوتوماتيك
    await db.collection("wallets").doc(id).set({
      balance: 0,
      currency: "USD",
      pendingBalance: 0,
    });

    const token = signToken(id);
    res.status(201).json({
      accessToken: token,
      token,
      refreshToken: null,
      user: toUserDto(id, userData),
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { email, username, password } = req.body || {};
    if (!password || (!email && !username)) {
      throw Errors.badRequest("password and (email or username) are required");
    }

    const usersRef = db.collection("users");
    const query = email
      ? usersRef.where("email", "==", email).limit(1)
      : usersRef.where("username", "==", username).limit(1);

    const snap = await query.get();
    if (snap.empty) throw Errors.unauthorized("Invalid credentials");

    const doc = snap.docs[0];
    const data = doc.data();
    const ok = await bcrypt.compare(password, data.passwordHash || "");
    if (!ok) throw Errors.unauthorized("Invalid credentials");

    const token = signToken(doc.id);
    res.json({
      accessToken: token,
      token,
      refreshToken: null,
      user: toUserDto(doc.id, data),
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout — الـ token عبارة عن JWT stateless، فبس بيتشال من الجهاز نفسه
router.post("/logout", requireAuth, async (_req, res) => {
  res.status(200).end();
});

// GET /auth/me  و  GET /users/me (نفس المنطق)
async function getMe(req: any, res: any, next: any) {
  try {
    const doc = await db.collection("users").doc(req.userId).get();
    if (!doc.exists) throw Errors.notFound("User");
    res.json(toUserDto(doc.id, doc.data()!));
  } catch (err) {
    next(err);
  }
}

router.get("/me", requireAuth, getMe);

export default router;
export { getMe, toUserDto };
