import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";
import { sendPushToUser } from "../lib/push";
import { createNotification } from "../lib/notifications";

const router = Router();
router.use(requireAuth);

function toConversationDto(
  id: string,
  d: FirebaseFirestore.DocumentData,
  myId: string
) {
  const otherId =
    (d.participantIds || []).find((p: string) => p !== myId) || null;

  return {
    id,
    type: d.type ?? "direct",
    otherUserId: otherId,
    otherUserName: d.otherUserNames?.[otherId] ?? null,
    otherUserAvatarUrl: d.otherUserAvatars?.[otherId] ?? null,
    lastMessage: d.lastMessage ?? null,
    lastMessageAt: d.lastMessageAt ?? null,
    unreadCount: d.unreadCounts?.[myId] ?? 0,
    productId: d.productId ?? null,
    // معرّف الطلب المرتبط بهذه المحادثة (لو كانت محادثة بائع/مشتري ناتجة
    // عن قبول طلب)، null لمحادثة دعم فني أو محادثة مباشرة عادية.
    orderId: d.orderId ?? null,
    // معرّف تذكرة الدعم المرتبطة بهذه المحادثة (لو كانت محادثة دعم فني)،
    // null لأي محادثة عادية بين مستخدمين.
    ticketId: d.ticketId ?? null,
  };
}

function toMessageDto(
  id: string,
  d: FirebaseFirestore.DocumentData
) {
  return {
    id,
    conversationId: d.conversationId ?? null,
    senderId: d.senderId ?? null,
    text: d.text ?? null,
    createdAt: d.createdAt ?? null,
    status: d.status ?? "sent",
  };
}

// GET /conversations
router.get("/", async (req, res, next) => {
  try {
    /*
     * بدون orderBy: array-contains + orderBy محتاج composite index لازم يكون
     * منشور، ولو مش منشور الطلب كان بيفشل والمحادثات ما بتظهرش أبدًا. كمان
     * orderBy بيستبعد أي محادثة مالهاش lastMessageAt. الترتيب بيتم هنا.
     */
    const snap = await db
      .collection("conversations")
      .where("participantIds", "array-contains", req.userId)
      .get();

    const docs = snap.docs.sort((a, b) =>
      String(b.data().lastMessageAt || "").localeCompare(
        String(a.data().lastMessageAt || "")
      )
    );

    res.json(
      docs.map((d) =>
        toConversationDto(
          d.id,
          d.data(),
          req.userId!
        )
      )
    );
  } catch (err) {
    next(err);
  }
});

/*
 * =========================================================
 * POST /conversations/start
 *
 * ينشئ محادثة مباشرة بين المستخدم الحالي ومستخدم آخر (مثلاً
 * عند الضغط على "تواصل مع البائع" في صفحة منتج)، أو يرجّع
 * المحادثة الموجودة مسبقًا بين نفس الطرفين بدل إنشاء تكرار.
 * =========================================================
 */
router.post("/start", async (req, res, next) => {
  try {
    const { otherUserId, productId } = req.body || {};

    if (!otherUserId || typeof otherUserId !== "string") {
      throw Errors.badRequest("otherUserId is required");
    }

    if (otherUserId === req.userId) {
      throw Errors.badRequest("Cannot start a conversation with yourself");
    }

    const existingSnap = await db
      .collection("conversations")
      .where("participantIds", "array-contains", req.userId)
      .get();

    const existing = existingSnap.docs.find(
      (d) =>
        (d.data().type ?? "direct") === "direct" &&
        (d.data().participantIds || []).includes(otherUserId)
    );

    if (existing) {
      return res.json(
        toConversationDto(existing.id, existing.data(), req.userId!)
      );
    }

    const otherUserDoc = await db.collection("users").doc(otherUserId).get();

    if (!otherUserDoc.exists) {
      throw Errors.notFound("User");
    }

    const meDoc = await db.collection("users").doc(req.userId!).get();
    const meData = meDoc.exists ? meDoc.data()! : {};
    const otherData = otherUserDoc.data()!;

    const now = new Date().toISOString();
    const id = uuid();

    const conversationData = {
      type: "direct",
      participantIds: [req.userId, otherUserId],
      otherUserNames: {
        [req.userId!]: meData.displayName || meData.username || null,
        [otherUserId]: otherData.displayName || otherData.username || null,
      },
      otherUserAvatars: {
        [req.userId!]: meData.avatarUrl || null,
        [otherUserId]: otherData.avatarUrl || null,
      },
      lastMessage: null,
      lastMessageAt: now,
      unreadCounts: { [req.userId!]: 0, [otherUserId]: 0 },
      productId: productId ? String(productId) : null,
      ticketId: null,
      createdAt: now,
    };

    await db.collection("conversations").doc(id).set(conversationData);

    res.status(201).json(toConversationDto(id, conversationData, req.userId!));
  } catch (err) {
    next(err);
  }
});

async function assertParticipant(
  conversationId: string,
  userId: string
) {
  const doc = await db
    .collection("conversations")
    .doc(conversationId)
    .get();

  if (!doc.exists) {
    throw Errors.notFound("Conversation");
  }

  if (!(doc.data()!.participantIds || []).includes(userId)) {
    throw Errors.forbidden(
      "Not a participant in this conversation"
    );
  }

  return doc;
}

// GET /conversations/:id/messages
router.get("/:id/messages", async (req, res, next) => {
  try {
    await assertParticipant(
      req.params.id,
      req.userId!
    );

    const snap = await db
      .collection("conversations")
      .doc(req.params.id)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();

    const items = snap.docs
      .map((d) => toMessageDto(d.id, d.data()))
      .reverse();

    const { page, limit } = parsePageParams(
      req.query as any
    );

    const start = Math.max(
      0,
      items.length - page * limit
    );

    const end =
      items.length - (page - 1) * limit;

    res.json(
      buildPaginatedResponse(
        items.slice(start, end),
        items.length,
        page,
        limit
      )
    );
  } catch (err) {
    next(err);
  }
});

// POST /conversations/:id/messages
router.post("/:id/messages", async (req, res, next) => {
  try {
    const conversationDoc =
      await assertParticipant(
        req.params.id,
        req.userId!
      );

    const { text } = req.body || {};

    if (!text || !String(text).trim()) {
      throw Errors.badRequest(
        "text is required"
      );
    }

    const now = new Date().toISOString();
    const id = uuid();

    const messageData = {
      conversationId: req.params.id,
      senderId: req.userId,
      text,
      createdAt: now,
      status: "sent",
    };

    const conversationRef =
      conversationDoc.ref;

    await conversationRef
      .collection("messages")
      .doc(id)
      .set(messageData);

    const conversationData = conversationDoc.data()!;

    const participants: string[] =
      conversationData.participantIds || [];

    const unreadCounts = {
      ...(conversationData.unreadCounts || {}),
    };

    for (const uid of participants) {
      if (uid !== req.userId) {
        unreadCounts[uid] =
          (unreadCounts[uid] || 0) + 1;
      }
    }

    await conversationRef.update({
      lastMessage: text,
      lastMessageAt: now,
      unreadCounts,
    });

    /*
     * إشعار + Push للطرف الآخر (لو التطبيق مغلق عنده هيوصله
     * كإشعار نظام حقيقي عن طريق FCM، أما لو التطبيق مفتوح
     * فهيستقبل الرسالة فورًا عن طريق الـ Firestore listener،
     * والـ Push هيتجاهله تلقائيًا لو نفس المحادثة مفتوحة عنده).
     */
    const senderName =
      conversationData.otherUserNames?.[req.userId!] || "مستخدم";

    for (const uid of participants) {
      if (uid === req.userId) continue;

      const notifTitle =
        conversationData.type === "support" ? "رسالة دعم جديدة" : senderName;
      const notifBody = String(text).slice(0, 200);

      await sendPushToUser(uid, notifTitle, notifBody, {
        type: "chat_message",
        conversationId: req.params.id,
        ticketId: conversationData.ticketId ? String(conversationData.ticketId) : "",
      });

      // "admin" ليس مستخدم Firebase حقيقي (لوحة الإدارة بتستخدم مفتاح إداري
      // منفصل)، فمفيش داعي/معنى لكتابة إشعار داخل التطبيق له.
      if (uid !== "admin") {
        await createNotification(uid, "chat_message", notifTitle, notifBody, {
          conversationId: req.params.id,
        });
      }
    }

    res.status(201).json(
      toMessageDto(id, messageData)
    );
  } catch (err) {
    next(err);
  }
});

/*
 * =========================================================
 * PATCH /conversations/:id/read
 *
 * يصفّر عدّاد الرسائل غير المقروءة للمستخدم الحالي في هذه
 * المحادثة. يُستدعى عند فتح شاشة المحادثة.
 * =========================================================
 */
router.patch("/:id/read", async (req, res, next) => {
  try {
    const conversationDoc = await assertParticipant(
      req.params.id,
      req.userId!
    );

    const unreadCounts = {
      ...(conversationDoc.data()!.unreadCounts || {}),
      [req.userId!]: 0,
    };

    await conversationDoc.ref.update({ unreadCounts });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
