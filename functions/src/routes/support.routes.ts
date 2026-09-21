import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

/*
 * =========================================================
 * SUPPORT TICKETS (نظام الشكاوى والدعم)
 *
 * يحل محل نظام الطلبات القديم بالكامل. كل تذكرة مرتبطة
 * بمحادثة واحدة فقط في مجموعة "conversations" (type: "support")
 * حتى لا يتم إنشاء محادثة جديدة في كل مرة، ونفس نقاط النهاية
 * الموجودة في chat.routes.ts (GET/POST /conversations/:id/messages)
 * تُستخدم لقراءة وإرسال رسائل هذه المحادثة من جهة المستخدم.
 *
 * جهة الإدارة (تغيير الحالة/الأولوية والرد) موجودة في
 * admin.routes.ts ومحمية بمفتاح الإدارة (x-admin-key)، بنفس
 * أسلوب لوحة التحكم الحالية - وليس عن طريق userId/role قادم
 * من تطبيق Android.
 * =========================================================
 */

export const TICKET_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_USER",
  "RESOLVED",
  "CLOSED",
] as const;

export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

function toTicketDto(id: string, d: FirebaseFirestore.DocumentData) {
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

// GET /support/tickets — تذاكر المستخدم الحالي فقط
router.get("/tickets", async (req, res, next) => {
  try {
    const snap = await db
      .collection("supportTickets")
      .where("userId", "==", req.userId)
      .orderBy("createdAt", "desc")
      .get();

    res.json(snap.docs.map((d) => toTicketDto(d.id, d.data())));
  } catch (err) {
    next(err);
  }
});

// GET /support/tickets/:id
router.get("/tickets/:id", async (req, res, next) => {
  try {
    const doc = await db.collection("supportTickets").doc(req.params.id).get();

    if (!doc.exists) {
      throw Errors.notFound("Support ticket");
    }

    if (doc.data()!.userId !== req.userId) {
      throw Errors.forbidden("Not your support ticket");
    }

    res.json(toTicketDto(doc.id, doc.data()!));
  } catch (err) {
    next(err);
  }
});

// POST /support/tickets — إنشاء شكوى/طلب مساعدة جديد
router.post("/tickets", async (req, res, next) => {
  try {
    const { subject, description, category } = req.body || {};

    if (!subject || !String(subject).trim()) {
      throw Errors.badRequest("subject is required");
    }

    if (!description || !String(description).trim()) {
      throw Errors.badRequest("description is required");
    }

    const userDoc = await db.collection("users").doc(req.userId!).get();
    const userData = userDoc.exists ? userDoc.data()! : {};
    const userName = userData.displayName || userData.username || null;

    const now = new Date().toISOString();
    const ticketId = uuid();
    const conversationId = uuid();

    const ticketData = {
      userId: req.userId,
      userName,
      subject: String(subject).trim(),
      description: String(description).trim(),
      category: category ? String(category).trim() : "GENERAL",
      status: "OPEN",
      priority: "NORMAL",
      conversationId,
      createdAt: now,
      updatedAt: now,
    };

    const conversationData = {
      type: "support",
      participantIds: [req.userId, "admin"],
      otherUserNames: { [req.userId!]: userName, admin: "الدعم الفني" },
      otherUserAvatars: { [req.userId!]: userData.avatarUrl || null, admin: null },
      lastMessage: String(description).trim(),
      lastMessageAt: now,
      unreadCounts: { [req.userId!]: 0, admin: 1 },
      productId: null,
      ticketId,
      createdAt: now,
    };

    const batch = db.batch();

    const ticketRef = db.collection("supportTickets").doc(ticketId);
    const conversationRef = db.collection("conversations").doc(conversationId);
    const firstMessageRef = conversationRef.collection("messages").doc(uuid());

    batch.set(ticketRef, ticketData);
    batch.set(conversationRef, conversationData);
    batch.set(firstMessageRef, {
      conversationId,
      senderId: req.userId,
      text: String(description).trim(),
      createdAt: now,
      status: "sent",
    });

    await batch.commit();

    res.status(201).json(toTicketDto(ticketId, ticketData));
  } catch (err) {
    next(err);
  }
});

export default router;
