import { v4 as uuid } from "uuid";
import { db } from "../firebase";
import { sendPushToUser } from "./push";
import { createNotification as createInAppNotification } from "./notifications";

/*
 * محادثات النزاع: لكل طرف (مشتري / بائع) محادثة خاصة مع الإدارة برقم ثابت
 * (dispute_<orderId>_<userId>)، فمستحيل تتكرر. نوعها "support" فبتظهر عند
 * المستخدم في شاشة الرسائل باسم "الدعم الفني" ويقدر يرد عليها بالطريقة العادية.
 */

export function disputeConversationId(orderId: string, userId: string): string {
  return `dispute_${orderId}_${userId}`;
}

export async function sendDisputeMessage(
  orderId: string,
  userId: string,
  text: string,
  role: "buyer" | "seller"
) {
  const conversationId = disputeConversationId(orderId, userId);
  const conversationRef = db.collection("conversations").doc(conversationId);

  const [conversationDoc, userDoc] = await Promise.all([
    conversationRef.get(),
    db.collection("users").doc(userId).get(),
  ]);

  const userData = userDoc.exists ? userDoc.data()! : {};
  const userName = userData.displayName || userData.username || null;
  const now = new Date().toISOString();

  if (!conversationDoc.exists) {
    await conversationRef.set({
      type: "support",
      participantIds: [userId, "admin"],
      otherUserNames: { [userId]: userName, admin: "الدعم الفني" },
      otherUserAvatars: { [userId]: userData.avatarUrl || null, admin: null },
      lastMessage: null,
      lastMessageAt: now,
      unreadCounts: { [userId]: 0, admin: 0 },
      productId: null,
      ticketId: null,
      orderId,
      disputeParty: role,
      createdAt: now,
    });
  }

  const messageId = uuid();

  await conversationRef.collection("messages").doc(messageId).set({
    conversationId,
    senderId: "admin",
    text,
    createdAt: now,
    status: "sent",
  });

  const existing = conversationDoc.exists ? conversationDoc.data()! : {};
  const unreadCounts = {
    ...(existing.unreadCounts || {}),
    [userId]: Number(existing.unreadCounts?.[userId] || 0) + 1,
  };

  await conversationRef.update({ lastMessage: text, lastMessageAt: now, unreadCounts });

  await sendPushToUser(userId, "رسالة من الدعم الفني", text.slice(0, 200), {
    type: "chat_message",
    conversationId,
    ticketId: "",
  });

  await createInAppNotification(userId, "chat_message", "رسالة من الدعم الفني", text.slice(0, 200), {
    conversationId,
  });

  return { conversationId, messageId };
}
