import { Errors } from "./errors";

/*
 * =========================================================
 * نظام الشكاوى والدعم — الثوابت والتحقق والـ DTOs
 *
 * الـ Collections في Firestore:
 *   complaints/{id}
 *   complaints/{id}/messages/{messageId}
 *   counters/complaints            (عدّاد رقم الشكوى)
 *
 * كل الكتابة من الـ Backend فقط (Admin SDK). الأندرويد ولوحة
 * الأدمن بيقروا Realtime من Firestore حسب firestore.rules.
 * =========================================================
 */

export const COMPLAINT_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_USER",
  "RESOLVED",
  "CLOSED",
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type ComplaintPriority = (typeof COMPLAINT_PRIORITIES)[number];

export const COMPLAINT_TYPES = [
  "ORDER_ISSUE",
  "PAYMENT",
  "ACCOUNT",
  "SELLER_REPORT",
  "PRODUCT",
  "TECHNICAL",
  "SUGGESTION",
  "OTHER",
] as const;
export type ComplaintType = (typeof COMPLAINT_TYPES)[number];

export type MessageKind =
  | "message"
  | "info_request"
  | "status_change"
  | "priority_change";

export type SenderRole = "user" | "admin" | "system";

export const LIMITS = {
  SUBJECT_MIN: 3,
  SUBJECT_MAX: 120,
  DESCRIPTION_MIN: 10,
  DESCRIPTION_MAX: 4000,
  MESSAGE_MAX: 2000,
  /* أقصى عدد شكاوى مفتوحة (مش RESOLVED/CLOSED) لمستخدم واحد — بيمنع الإغراق. */
  MAX_ACTIVE_PER_USER: 10,
  /* أقصى عدد مستندات بنقراه في قوائم الأدمن قبل الفلترة في الذاكرة. */
  ADMIN_SCAN_LIMIT: 1000,
} as const;

export const CLIENT_MESSAGE_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

/* --------------------------------------------------------- الحالات */

/* تسميات محايدة بتظهر في سجل الشكوى (الأدمن والمستخدم بيشوفوا نفس النص). */
export const STATUS_LABEL_AR: Record<ComplaintStatus, string> = {
  OPEN: "مفتوحة",
  IN_PROGRESS: "قيد المعالجة",
  WAITING_FOR_USER: "بانتظار رد المستخدم",
  RESOLVED: "تم الحل",
  CLOSED: "مغلقة",
};

/* تسميات موجهة للمستخدم في الإشعارات. */
export const STATUS_LABEL_USER_AR: Record<ComplaintStatus, string> = {
  ...STATUS_LABEL_AR,
  WAITING_FOR_USER: "بانتظار ردّك",
};

export const PRIORITY_LABEL_AR: Record<ComplaintPriority, string> = {
  LOW: "منخفضة",
  MEDIUM: "متوسطة",
  HIGH: "عالية",
  URGENT: "عاجلة",
};

export function isComplaintStatus(v: unknown): v is ComplaintStatus {
  return typeof v === "string" && (COMPLAINT_STATUSES as readonly string[]).includes(v);
}

export function isComplaintPriority(v: unknown): v is ComplaintPriority {
  return typeof v === "string" && (COMPLAINT_PRIORITIES as readonly string[]).includes(v);
}

export function isComplaintType(v: unknown): v is ComplaintType {
  return typeof v === "string" && (COMPLAINT_TYPES as readonly string[]).includes(v);
}

/**
 * قواعد الانتقال بين الحالات (بيطبّقها الأدمن فقط):
 *  - نفس الحالة → مرفوض.
 *  - الشكوى المغلقة (CLOSED) ما بتتفتحش غير بإعادة الفتح (OPEN).
 *  - باقي الانتقالات مسموحة.
 */
export function assertTransition(from: ComplaintStatus, to: ComplaintStatus): void {
  if (from === to) {
    throw Errors.badRequest("الشكوى بالفعل في هذه الحالة");
  }
  if (from === "CLOSED" && to !== "OPEN") {
    throw Errors.conflict("الشكوى مغلقة — أعد فتحها أولًا قبل تغيير حالتها");
  }
}

/* --------------------------------------------------------- التحقق */

function cleanText(v: unknown): string {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "";
}

export interface NewComplaintInput {
  type: ComplaintType;
  priority: ComplaintPriority;
  subject: string;
  description: string;
  orderId: string | null;
}

/* مهم: مفيش أي حقل هوية أو دور هنا — المستخدم بيتحدد من التوكن فقط. */
export function parseNewComplaint(body: any): NewComplaintInput {
  const b = body && typeof body === "object" ? body : {};

  const type = typeof b.type === "string" ? b.type.trim().toUpperCase() : "";
  if (!isComplaintType(type)) {
    throw Errors.badRequest("نوع الشكوى غير صحيح");
  }

  const rawPriority =
    typeof b.priority === "string" && b.priority.trim() ? b.priority.trim().toUpperCase() : "MEDIUM";
  if (!isComplaintPriority(rawPriority)) {
    throw Errors.badRequest("أولوية الشكوى غير صحيحة");
  }

  const subject = cleanText(b.subject);
  if (subject.length < LIMITS.SUBJECT_MIN || subject.length > LIMITS.SUBJECT_MAX) {
    throw Errors.badRequest(
      `عنوان الشكوى لازم يكون بين ${LIMITS.SUBJECT_MIN} و${LIMITS.SUBJECT_MAX} حرف`
    );
  }

  const description = cleanText(b.description);
  if (description.length < LIMITS.DESCRIPTION_MIN || description.length > LIMITS.DESCRIPTION_MAX) {
    throw Errors.badRequest(
      `تفاصيل الشكوى لازم تكون بين ${LIMITS.DESCRIPTION_MIN} و${LIMITS.DESCRIPTION_MAX} حرف`
    );
  }

  const orderId =
    typeof b.orderId === "string" && b.orderId.trim() ? b.orderId.trim().slice(0, 128) : null;

  return { type, priority: rawPriority, subject, description, orderId };
}

export interface ComplaintUpdateInput {
  status?: ComplaintStatus;
  priority?: ComplaintPriority;
  note: string | null;
}

/* تحديث الأدمن: حالة و/أو أولوية و/أو ملاحظة (بتظهر للمستخدم كرسالة). */
export function parseComplaintUpdate(body: any): ComplaintUpdateInput {
  const b = body && typeof body === "object" ? body : {};
  const out: ComplaintUpdateInput = { note: null };

  if (b.status !== undefined && b.status !== null && b.status !== "") {
    const status = typeof b.status === "string" ? b.status.trim().toUpperCase() : "";
    if (!isComplaintStatus(status)) {
      throw Errors.badRequest("الحالة غير صحيحة");
    }
    out.status = status;
  }

  if (b.priority !== undefined && b.priority !== null && b.priority !== "") {
    const priority = typeof b.priority === "string" ? b.priority.trim().toUpperCase() : "";
    if (!isComplaintPriority(priority)) {
      throw Errors.badRequest("الأولوية غير صحيحة");
    }
    out.priority = priority;
  }

  if (b.note !== undefined && b.note !== null && String(b.note).trim() !== "") {
    out.note = parseMessageText({ text: b.note });
  }

  if (out.status === undefined && out.priority === undefined && out.note === null) {
    throw Errors.badRequest("لا توجد تغييرات لتطبيقها");
  }

  return out;
}

export function parseMessageText(body: any): string {
  const raw = body && typeof body === "object" ? body.text : undefined;
  const text = cleanText(raw);
  if (!text) {
    throw Errors.badRequest("text is required");
  }
  if (text.length > LIMITS.MESSAGE_MAX) {
    throw Errors.badRequest(`text must be at most ${LIMITS.MESSAGE_MAX} characters`);
  }
  return text;
}

export function parseClientMessageId(body: any): string | null {
  const raw = body && typeof body === "object" ? body.clientMessageId : undefined;
  return typeof raw === "string" && CLIENT_MESSAGE_ID_REGEX.test(raw) ? raw : null;
}

/* --------------------------------------------------------- DTOs */

export function ticketCode(n: unknown): string | null {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return null;
  return "GC-" + String(Math.trunc(num)).padStart(5, "0");
}

export type Viewer = "user" | "admin";

export function toComplaintDto(id: string, d: FirebaseFirestore.DocumentData, viewer: Viewer) {
  const base = {
    id,
    ticketNumber: d.ticketNumber ?? null,
    code: d.code ?? ticketCode(d.ticketNumber),
    type: d.type ?? "OTHER",
    priority: d.priority ?? "MEDIUM",
    status: d.status ?? "OPEN",
    subject: d.subject ?? "",
    description: d.description ?? "",
    orderId: d.orderId ?? null,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
    lastMessage: d.lastMessage ?? null,
    lastMessageAt: d.lastMessageAt ?? null,
    lastMessageBy: d.lastMessageBy ?? null,
    resolvedAt: d.resolvedAt ?? null,
    closedAt: d.closedAt ?? null,
    reopenCount: d.reopenCount ?? 0,
    unreadCount: Number((viewer === "admin" ? d.unreadAdmin : d.unreadUser) ?? 0),
  };

  if (viewer === "user") {
    return base;
  }

  return {
    ...base,
    userId: d.userId ?? null,
    userName: d.userName ?? null,
    userEmail: d.userEmail ?? null,
    assignedTo: d.assignedTo ?? null,
    assignedToName: d.assignedToName ?? null,
  };
}

export const SUPPORT_TEAM_NAME = "فريق الدعم";

export function toComplaintMessageDto(
  id: string,
  d: FirebaseFirestore.DocumentData,
  viewer: Viewer
) {
  const senderRole: SenderRole = d.senderRole ?? "user";

  /* المستخدم بيشوف "فريق الدعم" بدل اسم الأدمن الشخصي. */
  const senderName =
    senderRole === "admin" && viewer === "user" ? SUPPORT_TEAM_NAME : d.senderName ?? null;

  return {
    id,
    /* conversationId بتتساب عشان MessageDto في الأندرويد يتعامل معاها كمحادثة عادية. */
    conversationId: d.complaintId ?? null,
    complaintId: d.complaintId ?? null,
    senderId: d.senderId ?? null,
    senderRole,
    senderName,
    kind: (d.kind as MessageKind | undefined) ?? "message",
    text: d.text ?? null,
    meta: d.meta ?? null,
    createdAt: d.createdAt ?? null,
    status: d.status ?? "sent",
  };
}

/* --------------------------------------------------------- نصوص النظام */

export function statusChangeText(from: ComplaintStatus, to: ComplaintStatus): string {
  return `تم تغيير حالة الشكوى من «${STATUS_LABEL_AR[from]}» إلى «${STATUS_LABEL_AR[to]}»`;
}

export function priorityChangeText(from: ComplaintPriority, to: ComplaintPriority): string {
  return `تم تغيير أولوية الشكوى من «${PRIORITY_LABEL_AR[from]}» إلى «${PRIORITY_LABEL_AR[to]}»`;
}

export function preview(text: string, max = 100): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
