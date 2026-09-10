import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";

const router = Router();

// مفتاح بسيط لحماية عمليات الأدمن - غيّره في functions/.env (ADMIN_SEED_KEY=...)
const ADMIN_KEY = process.env.ADMIN_SEED_KEY || "dev-only-change-me";

function checkAdminKey(req: any) {
  const key = req.header("x-admin-key") || req.query.key;
  if (key !== ADMIN_KEY) throw Errors.unauthorized("Invalid admin key");
}

const SAMPLE_GAMES = [
  { name: "PUBG Mobile", description: "حسابات وشدات ببجي موبايل" },
  { name: "Free Fire", description: "حسابات وجواهر فري فاير" },
  { name: "Fortnite", description: "حسابات وسكنات فورتنايت" },
  { name: "Call of Duty Mobile", description: "حسابات ورتب كول أوف ديوتي" },
];

const SAMPLE_CATEGORIES = [
  { name: "حسابات", description: "حسابات ألعاب جاهزة" },
  { name: "شدات وعملات", description: "عملات اللعبة داخل التطبيق" },
  { name: "سكنات ومظاهر", description: "سكنات وأزياء داخل اللعبة" },
];

// POST /admin/seed  (Header: x-admin-key: <ADMIN_SEED_KEY>)
// بيضيف ألعاب وفئات تجريبية أول مرة بس (بيتجاهل التكرار لو الاسم موجود بالفعل)
router.post("/seed", async (req, res, next) => {
  try {
    checkAdminKey(req);
    const now = new Date().toISOString();

    const gamesSnap = await db.collection("games").get();
    const existingGameNames = new Set(gamesSnap.docs.map((d) => d.data().name));
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
    const existingCategoryNames = new Set(categoriesSnap.docs.map((d) => d.data().name));
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

    res.json({ ok: true, addedGames, addedCategories });
  } catch (err) {
    next(err);
  }
});

export default router;
