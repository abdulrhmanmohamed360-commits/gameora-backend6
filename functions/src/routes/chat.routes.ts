import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import { requireAuth } from "../middleware/auth";
import { parsePageParams, buildPaginatedResponse } from "../lib/pagination";

const router = Router();
router.use(requireAuth);

function toConversationDto(id: string, d: FirebaseFirestore.DocumentData, myId: string) {
  const otherId = (d.participantIds || []).find((p: string) => p !== myId) || null;
  return {
    id,
    otherUserId: otherId,
    otherUserName: d.otherUserNames?.[otherId] ?? null,
    otherUserAvatarUrl: d.otherUserAvatars?.[otherId] ?? null,
    lastMessage: d.lastMessage ?? null,
    lastMessageAt: d.lastMessageAt ?? null,
    unreadCount: d.unreadCounts?.[myId] ?? 0,
    productId: d.productId ?? null,
  };
}

function toMessageDto(id: string, d: FirebaseFirestore.DocumentData) {
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
    res.json(snap.docs.map((d) => toConversationDto(d.id, d.data(), req.userId!)));
  } catch (err) {
    next(err);
  }
});

async function assertParticipant(conversationId: string, userId: string) {
  const doc = await db.collection("conversations").doc(conversationId).get();
  if (!doc.exists) throw Errors.notFound("Conversation");
  if (!(doc.data()!.participantIds || []).includes(userId)) {
    throw Errors.forbidden("Not a participant in this conversation");
  }
  return doc;
}

// GET /conversations/:id/messages
router.get("/:id/messages", async (req, res, next) => {
  try {
    await assertParticipant(req.params.id, req.userId!);

    const snap = await db
      .collection("conversations")
      .doc(req.params.id)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(500)
      .get();
    const items = snap.docs.map((d) => toMessageDto(d.id, d.data())).reverse();

    const { page, limit } = parsePageParams(req.query as any);
    const start = Math.max(0, items.length - page * limit);
    const end = items.length - (page - 1) * limit;
    res.json(buildPaginatedResponse(items.slice(start, end), items.length, page, limit));
  } catch (err) {
    next(err);
  }
});

// POST /conversations/:id/messages
router.post("/:id/messages", async (req, res, next) => {
  try {
    const conversationDoc = await assertParticipant(req.params.id, req.userId!);
    const { text } = req.body || {};
    if (!text || !String(text).trim()) throw Errors.badRequest("text is required");

    const now = new Date().toISOString();
    const id = uuid();
    const messageData = {
      conversationId: req.params.id,
      senderId: req.userId,
      text,
      createdAt: now,
      status: "sent",
    };
    const conversationRef = conversationDoc.ref;
    await conversationRef.collection("messages").doc(id).set(messageData);

    const participants: string[] = conversationDoc.data()!.participantIds || [];
    const unreadCounts = { ...(conversationDoc.data()!.unreadCounts || {}) };
    for (const uid of participants) {
      if (uid !== req.userId) unreadCounts[uid] = (unreadCounts[uid] || 0) + 1;
    }
    await conversationRef.update({
      lastMessage: text,
      lastMessageAt: now,
      unreadCounts,
    });

    res.status(201).json(toMessageDto(id, messageData));
  } catch (err) {
    next(err);
  }
});

export default router;
