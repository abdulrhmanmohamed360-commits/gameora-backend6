import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db, FieldValue } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";

const MAX_MESSAGE_LENGTH = 2000;
const CLIENT_MESSAGE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

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
    otherUserId: otherId,
    otherUserName: d.otherUserNames?.[otherId] ?? null,
    otherUserAvatarUrl: d.otherUserAvatars?.[otherId] ?? null,
    lastMessage: d.lastMessage ?? null,
    lastMessageAt: d.lastMessageAt ?? null,
    unreadCount: d.unreadCounts?.[myId] ?? 0,
    productId: d.productId ?? null,
    orderId: d.orderId ?? null,
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
    const snap = await db
      .collection("conversations")
      .where("participantIds", "array-contains", req.userId)
      .orderBy("lastMessageAt", "desc")
      .get();

    res.json(
      snap.docs.map((d) =>
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
//
// الإرسال بيفضل من خلال الـ Backend. التطبيق بيبعت clientMessageId (اختياري)
// وبنستخدمه كـ document id، فلو نفس الرسالة اتبعتت مرتين (retry / ضغطتين)
// مش هتتكرر — بنرجّع الرسالة الموجودة بدل ما نعمل واحدة جديدة.
router.post("/:id/messages", async (req, res, next) => {
  try {
    const conversationDoc = await assertParticipant(
      req.params.id,
      req.userId!
    );

    const rawText = (req.body || {}).text;
    const text =
      typeof rawText === "string" ? rawText.trim() : "";

    if (!text) {
      throw Errors.badRequest("text is required");
    }

    if (text.length > MAX_MESSAGE_LENGTH) {
      throw Errors.badRequest(
        `text must be at most ${MAX_MESSAGE_LENGTH} characters`
      );
    }

    const rawClientId = (req.body || {}).clientMessageId;
    const id =
      typeof rawClientId === "string" &&
      CLIENT_MESSAGE_ID_REGEX.test(rawClientId)
        ? rawClientId
        : uuid();

    const now = new Date().toISOString();

    const messageData = {
      conversationId: req.params.id,
      senderId: req.userId,
      text,
      createdAt: now,
      status: "sent",
    };

    const conversationRef = conversationDoc.ref;
    const messageRef = conversationRef.collection("messages").doc(id);

    const participants: string[] =
      conversationDoc.data()!.participantIds || [];

    /*
     * الرسالة + آخر رسالة + عدّاد غير المقروء في batch واحد (atomic).
     * increment() بيمنع ضياع العدّاد لو وصلت رسالتين في نفس اللحظة.
     */
    const conversationUpdate: Record<string, any> = {
      lastMessage: text,
      lastMessageAt: now,
      lastMessageSenderId: req.userId,
      updatedAt: now,
    };

    for (const uid of participants) {
      if (uid !== req.userId) {
        conversationUpdate[`unreadCounts.${uid}`] =
          FieldValue.increment(1);
      }
    }

    const batch = db.batch();
    batch.create(messageRef, messageData);
    batch.update(conversationRef, conversationUpdate);

    try {
      await batch.commit();
    } catch (err: any) {
      // 6 = ALREADY_EXISTS → نفس clientMessageId اتبعت قبل كده.
      if (err?.code === 6 || err?.code === "already-exists") {
        const existing = await messageRef.get();

        if (existing.exists && existing.data()!.senderId === req.userId) {
          return res
            .status(200)
            .json(toMessageDto(existing.id, existing.data()!));
        }

        throw Errors.conflict("Message id already in use");
      }

      throw err;
    }

    res.status(201).json(toMessageDto(id, messageData));
  } catch (err) {
    next(err);
  }
});

// POST /conversations/:id/read  (Mark as read)
//
// بيصفّر Unread Count للمستخدم الحالي، وبيحوّل رسائل الطرف الآخر
// من "sent" إلى "read" (فالمرسل يشوف علامة القراءة لحظيًا عن طريق
// الـ Firestore listener). آمن للتكرار (idempotent).
router.post("/:id/read", async (req, res, next) => {
  try {
    const uid = req.userId!;
    const conversationDoc = await assertParticipant(req.params.id, uid);
    const conversationRef = conversationDoc.ref;
    const now = new Date().toISOString();

    const unreadSnap = await conversationRef
      .collection("messages")
      .where("status", "==", "sent")
      .get();

    const toMark = unreadSnap.docs.filter(
      (d) => d.data().senderId !== uid
    );

    for (let i = 0; i < toMark.length; i += 400) {
      const batch = db.batch();

      toMark.slice(i, i + 400).forEach((d) => {
        batch.update(d.ref, { status: "read", readAt: now });
      });

      await batch.commit();
    }

    await conversationRef.update({
      [`unreadCounts.${uid}`]: 0,
    });

    res.json({ conversationId: req.params.id, marked: toMark.length });
  } catch (err) {
    next(err);
  }
});

export default router;
