import * as admin from "firebase-admin";
import { db } from "../firebase";
import { Errors } from "../lib/errors";
import {
  ADMIN_SCAN_LIMIT,
  COMPLAINT_STATUSES,
  ComplaintPriority,
  ComplaintStatus,
  ComplaintType,
  LIMITS,
  MessageKind,
  SenderRole,
  assertTransition,
  preview,
  statusChangeText,
  priorityChangeText,
  ticketCode,
  toComplaintDto,
  toComplaintMessageDto,
} from "../lib/complaints";

export interface Actor {
  uid: string;
  name?: string | null;
  email?: string | null;
  role?: "admin" | "support" | "user";
}

interface UserProfile {
  uid: string;
  name: string;
  email: string | null;
}

interface PostMessageOptions {
  clientMessageId?: string | null;
}

const complaintsRef = db.collection("complaints");
const counterRef = db.collection("counters").doc("complaints");

function complaintRef(id: string) {
  return complaintsRef.doc(id);
}

function messagesRef(id: string) {
  return complaintRef(id).collection("messages");
}

function isoDate(value: any): string | null {
  if (!value) return null;

  if (value instanceof admin.firestore.Timestamp) {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value?.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return null;
}

function serializeData(data: FirebaseFirestore.DocumentData) {
  const out: Record<string, any> = {};

  for (const [key, value] of Object.entries(data || {})) {
    if (value instanceof admin.firestore.Timestamp) {
      out[key] = value.toDate().toISOString();
    } else {
      out[key] = value;
    }
  }

  return out;
}

function activeStatus(status: ComplaintStatus): boolean {
  return status !== "RESOLVED" && status !== "CLOSED";
}

async function getUserProfile(uid: string): Promise<UserProfile> {
  const snap = await db.collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() || {} : {};

  return {
    uid,
    name: String(
      data.displayName ||
        data.username ||
        data.name ||
        data.email ||
        "مستخدم Gameora"
    ),
    email: typeof data.email === "string" ? data.email : null,
  };
}

async function nextTicketNumber(
  transaction: FirebaseFirestore.Transaction
): Promise<number> {
  const snap = await transaction.get(counterRef);
  const current = snap.exists ? Number(snap.data()?.value || 0) : 0;
  const next = current + 1;

  transaction.set(
    counterRef,
    {
      value: next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return next;
}

function messageDto(
  id: string,
  data: FirebaseFirestore.DocumentData,
  viewer: "user" | "admin"
) {
  const serialized = serializeData(data);
  return toComplaintMessageDto(id, serialized, viewer);
}

function complaintDto(
  id: string,
  data: FirebaseFirestore.DocumentData,
  viewer: "user" | "admin"
) {
  return toComplaintDto(id, serializeData(data), viewer);
}

/* =========================================================
   إنشاء شكوى
   ========================================================= */

export async function createComplaint(
  profile: UserProfile,
  input: {
    type: ComplaintType;
    priority: ComplaintPriority;
    subject: string;
    description: string;
    orderId: string | null;
  }
) {
  const existing = await complaintsRef
    .where("userId", "==", profile.uid)
    .where("status", "in", [...COMPLAINT_STATUSES])
    .limit(LIMITS.MAX_ACTIVE_PER_USER + 1)
    .get();

  const activeCount = existing.docs.filter((doc) =>
    activeStatus((doc.data().status || "OPEN") as ComplaintStatus)
  ).length;

  if (activeCount >= LIMITS.MAX_ACTIVE_PER_USER) {
    throw Errors.conflict(
      `لا يمكنك إنشاء أكثر من ${LIMITS.MAX_ACTIVE_PER_USER} شكاوى مفتوحة في نفس الوقت`
    );
  }

  const ref = complaintsRef.doc();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const result = await db.runTransaction(async (transaction) => {
    const ticketNumber = await nextTicketNumber(transaction);

    transaction.set(ref, {
      userId: profile.uid,
      userName: profile.name,
      userEmail: profile.email,

      ticketNumber,
      code: ticketCode(ticketNumber),

      type: input.type,
      priority: input.priority,
      status: "OPEN",

      subject: input.subject,
      description: input.description,
      orderId: input.orderId,

      assignedTo: null,
      assignedToName: null,

      lastMessage: input.description,
      lastMessageAt: now,
      lastMessageBy: "user",

      unreadUser: 0,
      unreadAdmin: 1,

      resolvedAt: null,
      closedAt: null,
      reopenCount: 0,

      createdAt: now,
      updatedAt: now,
    });

    const messageRef = messagesRef(ref.id).doc();

    transaction.set(messageRef, {
      complaintId: ref.id,
      senderId: profile.uid,
      senderRole: "user" as SenderRole,
      senderName: profile.name,
      kind: "message" as MessageKind,
      text: input.description,
      meta: {
        initialComplaint: true,
      },
      clientMessageId: null,
      createdAt: now,
      status: "sent",
    });

    return {
      id: ref.id,
      ticketNumber,
      code: ticketCode(ticketNumber),
    };
  });

  const created = await ref.get();

  return complaintDto(created.id, created.data() || {}, "user");
}

/* =========================================================
   شكاوى المستخدم
   ========================================================= */

export async function listUserComplaints(
  uid: string,
  options: {
    status?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const page = Math.max(1, Number(options.page || 1));
  const limit = Math.min(50, Math.max(1, Number(options.limit || 20)));

  let query: FirebaseFirestore.Query = complaintsRef.where(
    "userId",
    "==",
    uid
  );

  if (options.status) {
    query = query.where("status", "==", options.status);
  }

  query = query.orderBy("updatedAt", "desc");

  const snap = await query
    .limit(page * limit)
    .get();

  const start = (page - 1) * limit;
  const docs = snap.docs.slice(start, start + limit);

  return {
    items: docs.map((doc) =>
      complaintDto(doc.id, doc.data(), "user")
    ),
    page,
    limit,
    hasMore: snap.docs.length > start + docs.length,
  };
}

/* =========================================================
   شكوى المستخدم فقط
   ========================================================= */

export async function getOwnedComplaint(
  uid: string,
  id: string
) {
  const snap = await complaintRef(id).get();

  if (!snap.exists) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  const data = snap.data() || {};

  if (data.userId !== uid) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  return snap;
}

/* =========================================================
   شكاوى الأدمن
   ========================================================= */

export async function listAdminComplaints(
  options: {
    status?: string;
    priority?: string;
    search?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const page = Math.max(1, Number(options.page || 1));
  const limit = Math.min(100, Math.max(1, Number(options.limit || 20)));

  let query: FirebaseFirestore.Query = complaintsRef;

  if (options.status) {
    query = query.where("status", "==", options.status);
  }

  if (options.priority) {
    query = query.where("priority", "==", options.priority);
  }

  query = query.orderBy("updatedAt", "desc");

  const snap = await query
    .limit(LIMITS.ADMIN_SCAN_LIMIT)
    .get();

  let items = snap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
  }));

  const search = String(options.search || "").trim().toLowerCase();

  if (search) {
    items = items.filter(({ data }) => {
      const values = [
        data.code,
        data.ticketNumber,
        data.subject,
        data.userName,
        data.userEmail,
        data.userId,
        data.orderId,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());

      return values.some((v) => v.includes(search));
    });
  }

  const start = (page - 1) * limit;
  const selected = items.slice(start, start + limit);

  return {
    items: selected.map(({ id, data }) =>
      complaintDto(id, data, "admin")
    ),
    page,
    limit,
    total: items.length,
    hasMore: items.length > start + selected.length,
  };
}

/* =========================================================
   تفاصيل شكوى للأدمن
   ========================================================= */

export async function getComplaintForAdmin(id: string) {
  const snap = await complaintRef(id).get();

  if (!snap.exists) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  return complaintDto(snap.id, snap.data() || {}, "admin");
}

/* =========================================================
   إحصائيات الشكاوى
   ========================================================= */

export async function getComplaintCounts() {
  const snap = await complaintsRef
    .limit(LIMITS.ADMIN_SCAN_LIMIT)
    .get();

  const counts: Record<string, number> = {
    OPEN: 0,
    IN_PROGRESS: 0,
    WAITING_FOR_USER: 0,
    RESOLVED: 0,
    CLOSED: 0,
    TOTAL: 0,
  };

  for (const doc of snap.docs) {
    const status = String(doc.data().status || "OPEN");

    counts.TOTAL++;

    if (counts[status] !== undefined) {
      counts[status]++;
    }
  }

  return counts;
}

/* =========================================================
   رسائل الشكوى
   ========================================================= */

export async function listMessages(
  complaintId: string,
  viewer: "user" | "admin",
  page = 1,
  limit = 50
) {
  page = Math.max(1, Number(page || 1));
  limit = Math.min(100, Math.max(1, Number(limit || 50)));

  const snap = await messagesRef(complaintId)
    .orderBy("createdAt", "desc")
    .limit(page * limit)
    .get();

  const selected = snap.docs.slice(
    (page - 1) * limit,
    page * limit
  );

  selected.reverse();

  return {
    items: selected.map((doc) =>
      messageDto(doc.id, doc.data(), viewer)
    ),
    page,
    limit,
    hasMore: snap.docs.length >= page * limit,
  };
}

/* =========================================================
   إرسال رسالة
   ========================================================= */

export async function postMessage(
  actor: Actor,
  complaintId: string,
  text: string,
  options: PostMessageOptions = {}
) {
  const complaint = await complaintRef(complaintId).get();

  if (!complaint.exists) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  const complaintData = complaint.data() || {};

  if (
    actor.role !== "admin" &&
    actor.role !== "support" &&
    complaintData.userId !== actor.uid
  ) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  if (complaintData.status === "CLOSED") {
    throw Errors.conflict("الشكوى مغلقة. أعد فتحها أولًا.");
  }

  const clientMessageId = options.clientMessageId || null;

  if (clientMessageId) {
    const duplicate = await messagesRef(complaintId)
      .where("clientMessageId", "==", clientMessageId)
      .limit(1)
      .get();

    if (!duplicate.empty) {
      const doc = duplicate.docs[0];

      return {
        duplicate: true,
        message: messageDto(
          doc.id,
          doc.data(),
          actor.role === "admin" || actor.role === "support"
            ? "admin"
            : "user"
        ),
      };
    }
  }

  const role: SenderRole =
    actor.role === "admin" || actor.role === "support"
      ? "admin"
      : "user";

  const senderName =
    role === "admin"
      ? "فريق الدعم"
      : actor.name || complaintData.userName || "مستخدم Gameora";

  const messageRef = messagesRef(complaintId).doc();
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(complaintRef(complaintId));

    if (!current.exists) {
      throw Errors.notFound("الشكوى غير موجودة");
    }

    const currentData = current.data() || {};

    transaction.set(messageRef, {
      complaintId,
      senderId: actor.uid,
      senderRole: role,
      senderName,
      kind: "message",
      text,
      meta: null,
      clientMessageId,
      createdAt: now,
      status: "sent",
    });

    transaction.update(complaintRef(complaintId), {
      lastMessage: preview(text),
      lastMessageAt: now,
      lastMessageBy: role,
      updatedAt: now,

      ...(role === "admin"
        ? {
            unreadUser: admin.firestore.FieldValue.increment(1),
            unreadAdmin: 0,
          }
        : {
            unreadAdmin: admin.firestore.FieldValue.increment(1),
            unreadUser: 0,
          }),
    });
  });

  const saved = await messageRef.get();

  return {
    duplicate: false,
    message: messageDto(
      saved.id,
      saved.data() || {},
      role === "admin" ? "admin" : "user"
    ),
  };
}

/* =========================================================
   تعليم الرسائل كمقروءة
   ========================================================= */

export async function markRead(
  viewer: "user" | "admin",
  uid: string,
  complaintId: string
) {
  const ref = complaintRef(complaintId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  const data = snap.data() || {};

  if (viewer === "user" && data.userId !== uid) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  await ref.update({
    ...(viewer === "user"
      ? { unreadUser: 0 }
      : { unreadAdmin: 0 }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    unreadCount: 0,
  };
}

/* =========================================================
   تحديث الشكوى بواسطة الأدمن
   ========================================================= */

export async function updateComplaint(
  actor: Actor,
  complaintId: string,
  input: {
    status?: ComplaintStatus;
    priority?: ComplaintPriority;
    note?: string | null;
  }
) {
  const ref = complaintRef(complaintId);
  const snap = await ref.get();

  if (!snap.exists) {
    throw Errors.notFound("الشكوى غير موجودة");
  }

  const data = snap.data() || {};

  const oldStatus = String(
    data.status || "OPEN"
  ) as ComplaintStatus;

  const oldPriority = String(
    data.priority || "MEDIUM"
  ) as ComplaintPriority;

  const updates: Record<string, any> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const systemMessages: Array<{
    kind: MessageKind;
    text: string;
    meta: Record<string, any>;
  }> = [];

  if (input.status !== undefined) {
    assertTransition(oldStatus, input.status);

    updates.status = input.status;

    if (input.status === "RESOLVED") {
      updates.resolvedAt =
        admin.firestore.FieldValue.serverTimestamp();
    }

    if (input.status === "CLOSED") {
      updates.closedAt =
        admin.firestore.FieldValue.serverTimestamp();
    }

    if (input.status === "OPEN" && oldStatus === "CLOSED") {
      updates.closedAt = null;
      updates.resolvedAt = null;
      updates.reopenCount =
        admin.firestore.FieldValue.increment(1);
    }

    systemMessages.push({
      kind: "status_change",
      text: statusChangeText(oldStatus, input.status),
      meta: {
        from: oldStatus,
        to: input.status,
      },
    });
  }

  if (input.priority !== undefined) {
    if (oldPriority === input.priority) {
      throw Errors.badRequest("الشكوى بالفعل في هذه الأولوية");
    }

    updates.priority = input.priority;

    systemMessages.push({
      kind: "priority_change",
      text: priorityChangeText(oldPriority, input.priority),
      meta: {
        from: oldPriority,
        to: input.priority,
      },
    });
  }

  if (input.note) {
    systemMessages.push({
      kind: "info_request",
      text: input.note,
      meta: {
        adminNote: true,
      },
    });
  }

  if (systemMessages.length === 0) {
    throw Errors.badRequest("لا توجد تغييرات لتطبيقها");
  }

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  batch.update(ref, {
    ...updates,
    lastMessage: preview(
      systemMessages[systemMessages.length - 1].text
    ),
    lastMessageAt: now,
    lastMessageBy: "admin",
    unreadUser: admin.firestore.FieldValue.increment(1),
  });

  for (const item of systemMessages) {
    const msgRef = messagesRef(complaintId).doc();

    batch.set(msgRef, {
      complaintId,
      senderId: actor.uid,
      senderRole: "admin",
      senderName: "فريق الدعم",
      kind: item.kind,
      text: item.text,
      meta: item.meta,
      clientMessageId: null,
      createdAt: now,
      status: "sent",
    });
  }

  await batch.commit();

  const updated = await ref.get();

  return complaintDto(
    updated.id,
    updated.data() || {},
    "admin"
  );
      }
