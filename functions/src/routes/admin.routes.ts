import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";

const router = Router();

// مفتاح الأدمن
const ADMIN_KEY = process.env.ADMIN_SEED_KEY || "dev-only-change-me";

function checkAdminKey(req: any) {
  const key = req.header("x-admin-key") || req.query.key;

  if (!key || key !== ADMIN_KEY) {
    throw Errors.unauthorized("Invalid admin key");
  }
}

/* =========================================================
   SEED
   ========================================================= */

const SAMPLE_GAMES = [
  {
    name: "PUBG Mobile",
    description: "حسابات وشدات ببجي موبايل",
  },
  {
    name: "Free Fire",
    description: "حسابات وجواهر فري فاير",
  },
  {
    name: "Fortnite",
    description: "حسابات وسكنات فورتنايت",
  },
  {
    name: "Call of Duty Mobile",
    description: "حسابات ورتب كول أوف ديوتي",
  },
];

const SAMPLE_CATEGORIES = [
  {
    name: "حسابات",
    description: "حسابات ألعاب جاهزة",
  },
  {
    name: "شدات وعملات",
    description: "عملات اللعبة داخل التطبيق",
  },
  {
    name: "سكنات ومظاهر",
    description: "سكنات وأزياء داخل اللعبة",
  },
];

// POST /admin/seed
router.post("/seed", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const now = new Date().toISOString();

    const gamesSnap = await db.collection("games").get();

    const existingGameNames = new Set(
      gamesSnap.docs.map((d) => d.data().name)
    );

    let addedGames = 0;

    for (const g of SAMPLE_GAMES) {
      if (existingGameNames.has(g.name)) continue;

      await db.collection("games").doc(uuid()).set({
        ...g,
        imageUrl: null,
        iconUrl: null,
        bannerUrl: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      addedGames++;
    }

    const categoriesSnap = await db.collection("categories").get();

    const existingCategoryNames = new Set(
      categoriesSnap.docs.map((d) => d.data().name)
    );

    let addedCategories = 0;

    for (const c of SAMPLE_CATEGORIES) {
      if (existingCategoryNames.has(c.name)) continue;

      await db.collection("categories").doc(uuid()).set({
        ...c,
        iconUrl: null,
        imageUrl: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      addedCategories++;
    }

    res.json({
      ok: true,
      addedGames,
      addedCategories,
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   OFFERS
   ========================================================= */

// POST /admin/offers
// إنشاء عرض جديد
router.post("/offers", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const {
      title,
      gameId,
      oldPrice,
      discountPercent,
      currency,
      imageUrl,
      description,
      startAt,
      endAt,
    } = req.body || {};

    if (!title || !gameId) {
      return res.status(400).json({
        ok: false,
        message: "اسم العرض واللعبة مطلوبان",
      });
    }

    const price = Number(oldPrice);
    const discount = Number(discountPercent);

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({
        ok: false,
        message: "السعر الأصلي غير صحيح",
      });
    }

    if (
      !Number.isFinite(discount) ||
      discount < 0 ||
      discount > 100
    ) {
      return res.status(400).json({
        ok: false,
        message: "نسبة الخصم يجب أن تكون بين 0 و100",
      });
    }

    // الحساب يتم في السيرفر وليس اعتمادًا على السعر القادم من التطبيق
    const finalPrice = Number(
      (price - (price * discount) / 100).toFixed(2)
    );

    const now = new Date().toISOString();
    const id = uuid();

    const offer = {
      id,
      title: String(title).trim(),
      gameId: String(gameId),

      oldPrice: price,
      discountPercent: discount,
      finalPrice,

      currency: currency
        ? String(currency).trim().toUpperCase()
        : "EGP",

      imageUrl: imageUrl
        ? String(imageUrl).trim()
        : null,

      description: description
        ? String(description).trim()
        : null,

      startAt: startAt || null,
      endAt: endAt || null,

      status: "active",

      createdAt: now,
      updatedAt: now,
    };

    await db
      .collection("offers")
      .doc(id)
      .set(offer);

    return res.status(201).json({
      ok: true,
      offer,
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   GET OFFERS
   ========================================================= */

// GET /admin/offers
// جلب كل العروض للأدمن
router.get("/offers", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const snap = await db
      .collection("offers")
      .orderBy("createdAt", "desc")
      .get();

    const offers = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({
      ok: true,
      offers,
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   TOGGLE OFFER
   ========================================================= */

// POST /admin/offers/:id/toggle
// تفعيل / تعطيل العرض
router.post("/offers/:id/toggle", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const { id } = req.params;

    const ref = db.collection("offers").doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        ok: false,
        message: "العرض غير موجود",
      });
    }

    const currentStatus = doc.data()?.status;

    const newStatus =
      currentStatus === "active"
        ? "inactive"
        : "active";

    const updatedAt = new Date().toISOString();

    await ref.update({
      status: newStatus,
      updatedAt,
    });

    return res.json({
      ok: true,
      id,
      status: newStatus,
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   DELETE OFFER
   ========================================================= */

// DELETE /admin/offers/:id
// حذف العرض
router.delete("/offers/:id", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const { id } = req.params;

    const ref = db.collection("offers").doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        ok: false,
        message: "العرض غير موجود",
      });
    }

    await ref.delete();

    return res.json({
      ok: true,
      message: "تم حذف العرض",
      id,
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   ADMIN STATS
   ========================================================= */

// GET /admin/stats
router.get("/stats", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const [
      usersSnap,
      productsSnap,
      ordersSnap,
      offersSnap,
    ] = await Promise.all([
      db.collection("users").get(),
      db.collection("products").get(),
      db.collection("orders").get(),
      db.collection("offers").get(),
    ]);

    let activeOffers = 0;

    offersSnap.forEach((doc) => {
      if (doc.data()?.status === "active") {
        activeOffers++;
      }
    });

    return res.json({
      ok: true,

      users: usersSnap.size,
      products: productsSnap.size,
      orders: ordersSnap.size,

      offers: offersSnap.size,
      activeOffers,

      earnings: 0,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
