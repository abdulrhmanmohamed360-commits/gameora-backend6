import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { sendPushToUser } from "../lib/push";
import { createNotification } from "../lib/notifications";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "./support.routes";

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
      ticketsSnap,
      offersSnap,
    ] = await Promise.all([
      db.collection("users").get(),
      db.collection("products").get(),
      db.collection("supportTickets").get(),
      db.collection("offers").get(),
    ]);

    const disputedSnap = await db
      .collection("orders")
      .where("status", "==", "DISPUTED")
      .get();

    let activeOffers = 0;

    offersSnap.forEach((doc) => {
      if (doc.data()?.status === "active") {
        activeOffers++;
      }
    });

    let openTickets = 0;

    ticketsSnap.forEach((doc) => {
      const status = doc.data()?.status;
      if (status !== "RESOLVED" && status !== "CLOSED") {
        openTickets++;
      }
    });

    return res.json({
      ok: true,

      users: usersSnap.size,
      products: productsSnap.size,
      tickets: ticketsSnap.size,
      openTickets,

      disputedOrders: disputedSnap.size,

      offers: offersSnap.size,
      activeOffers,

      earnings: 0,
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   SUPPORT TICKETS (لوحة الإدارة)

   محمية بمفتاح الإدارة (checkAdminKey) بنفس أسلوب باقي هذا
   الملف - صلاحيات الإدارة بالكامل Server-side ولا تعتمد على
   أي شيء قادم من تطبيق Android.
   ========================================================= */

function toAdminTicketDto(id: string, d: FirebaseFirestore.DocumentData) {
  return {
    ticketId: id,
    userId: d.userId ?? null,
    userName: d.userName ?? null,
    subject: d.subject ?? null,
    description: d.description ?? null,
    category: d.category ?? null,
    status: d.status ?? "OPEN",
    priority: d.priority ?? "NORMAL",
    conversationId: d.conversationId ?? null,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

// GET /admin/support/tickets?status=&priority=
router.get("/support/tickets", async (req, res, next) => {
  try {
    checkAdminKey(req);

    let query: FirebaseFirestore.Query = db.collection("supportTickets");

    const { status, priority } = req.query as {
      status?: string;
      priority?: string;
    };

    if (status && TICKET_STATUSES.includes(status as any)) {
      query = query.where("status", "==", status);
    }

    if (priority && TICKET_PRIORITIES.includes(priority as any)) {
      query = query.where("priority", "==", priority);
    }

    const snap = await query.orderBy("createdAt", "desc").get();

    res.json({
      ok: true,
      tickets: snap.docs.map((d) => toAdminTicketDto(d.id, d.data())),
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/support/tickets/:id — تفاصيل التذكرة + رسائل محادثتها
router.get("/support/tickets/:id", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const ticketDoc = await db
      .collection("supportTickets")
      .doc(req.params.id)
      .get();

    if (!ticketDoc.exists) {
      throw Errors.notFound("Support ticket");
    }

    const ticket = ticketDoc.data()!;

    let messages: any[] = [];

    if (ticket.conversationId) {
      const messagesSnap = await db
        .collection("conversations")
        .doc(ticket.conversationId)
        .collection("messages")
        .orderBy("createdAt", "asc")
        .limit(500)
        .get();

      messages = messagesSnap.docs.map((d) => ({
        id: d.id,
        senderId: d.data().senderId ?? null,
        text: d.data().text ?? null,
        createdAt: d.data().createdAt ?? null,
        status: d.data().status ?? "sent",
      }));
    }

    res.json({
      ok: true,
      ticket: toAdminTicketDto(ticketDoc.id, ticket),
      messages,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/support/tickets/:id — تغيير الحالة و/أو الأولوية
router.patch("/support/tickets/:id", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const { status, priority } = req.body || {};

    if (status && !TICKET_STATUSES.includes(status)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid ticket status",
      });
    }

    if (priority && !TICKET_PRIORITIES.includes(priority)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid ticket priority",
      });
    }

    const ticketRef = db.collection("supportTickets").doc(req.params.id);
    const ticketDoc = await ticketRef.get();

    if (!ticketDoc.exists) {
      throw Errors.notFound("Support ticket");
    }

    const ticket = ticketDoc.data()!;
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };

    if (status) updates.status = status;
    if (priority) updates.priority = priority;

    await ticketRef.update(updates);

    /*
     * رسالة نظام داخل نفس محادثة التذكرة + إشعار Push للمستخدم
     * عند تغيير الحالة، حتى يعرف أن هناك تحديثًا حتى لو التطبيق
     * مغلق عنده.
     */
    if (status && ticket.conversationId) {
      const conversationRef = db
        .collection("conversations")
        .doc(ticket.conversationId);

      const statusLabels: Record<string, string> = {
        OPEN: "مفتوحة",
        IN_PROGRESS: "قيد المعالجة",
        WAITING_FOR_USER: "بانتظار ردك",
        RESOLVED: "تم الحل",
        CLOSED: "مغلقة",
      };

      const systemText = `تم تغيير حالة التذكرة إلى: ${
        statusLabels[status] || status
      }`;

      await conversationRef.collection("messages").doc(uuid()).set({
        conversationId: ticket.conversationId,
        senderId: "admin",
        text: systemText,
        createdAt: now,
        status: "sent",
        system: true,
      });

      const conversationDoc = await conversationRef.get();
      const unreadCounts = {
        ...(conversationDoc.data()?.unreadCounts || {}),
        [ticket.userId]: (conversationDoc.data()?.unreadCounts?.[ticket.userId] || 0) + 1,
      };

      await conversationRef.update({
        lastMessage: systemText,
        lastMessageAt: now,
        unreadCounts,
      });

      await sendPushToUser(
        ticket.userId,
        "تحديث حالة الشكوى",
        systemText,
        {
          type: "ticket_status",
          conversationId: ticket.conversationId,
          ticketId: req.params.id,
        }
      );

      await createNotification(
        ticket.userId,
        "ticket_status",
        "تحديث حالة الشكوى",
        systemText,
        { conversationId: ticket.conversationId }
      );
    }

    const updatedDoc = await ticketRef.get();

    res.json({
      ok: true,
      ticket: toAdminTicketDto(updatedDoc.id, updatedDoc.data()!),
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/support/tickets/:id/messages — رد الإدارة على المستخدم
router.post("/support/tickets/:id/messages", async (req, res, next) => {
  try {
    checkAdminKey(req);

    const { text } = req.body || {};

    if (!text || !String(text).trim()) {
      return res.status(400).json({
        ok: false,
        message: "text is required",
      });
    }

    const ticketDoc = await db
      .collection("supportTickets")
      .doc(req.params.id)
      .get();

    if (!ticketDoc.exists) {
      throw Errors.notFound("Support ticket");
    }

    const ticket = ticketDoc.data()!;

    if (!ticket.conversationId) {
      throw Errors.conflict("Ticket has no linked conversation");
    }

    const now = new Date().toISOString();
    const messageId = uuid();

    const conversationRef = db
      .collection("conversations")
      .doc(ticket.conversationId);

    const messageData = {
      conversationId: ticket.conversationId,
      senderId: "admin",
      text: String(text).trim(),
      createdAt: now,
      status: "sent",
    };

    await conversationRef.collection("messages").doc(messageId).set(messageData);

    const conversationDoc = await conversationRef.get();
    const unreadCounts = {
      ...(conversationDoc.data()?.unreadCounts || {}),
      [ticket.userId]: (conversationDoc.data()?.unreadCounts?.[ticket.userId] || 0) + 1,
    };

    await conversationRef.update({
      lastMessage: messageData.text,
      lastMessageAt: now,
      unreadCounts,
    });

    /*
     * لو التذكرة كانت بانتظار رد الإدارة، رد الإدارة يرجّعها
     * تلقائيًا لحالة "قيد المعالجة" بدل ما تفضل OPEN بشكل مضلل.
     */
    if (ticket.status === "OPEN" || ticket.status === "WAITING_FOR_USER") {
      await ticketDoc.ref.update({
        status: "IN_PROGRESS",
        updatedAt: now,
      });
    }

    await sendPushToUser(
      ticket.userId,
      "رد جديد من الدعم الفني",
      messageData.text.slice(0, 200),
      {
        type: "ticket_reply",
        conversationId: ticket.conversationId,
        ticketId: req.params.id,
      }
    );

    await createNotification(
      ticket.userId,
      "ticket_reply",
      "رد جديد من الدعم الفني",
      messageData.text.slice(0, 200),
      { conversationId: ticket.conversationId }
    );

    res.status(201).json({ ok: true, message: { id: messageId, ...messageData } });
  } catch (err) {
    next(err);
  }
});

export default router;
