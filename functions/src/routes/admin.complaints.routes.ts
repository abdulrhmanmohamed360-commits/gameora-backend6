import { Router } from "express";
import { requirePermission, StaffContext } from "../middleware/auth";
import { parsePageParams } from "../lib/pagination";
import { qs } from "../lib/adminUtil";
import {
  parseClientMessageId,
  parseComplaintUpdate,
  parseMessageText,
} from "../lib/complaints";
import {
  Actor,
  getComplaintCounts,
  getComplaintForAdmin,
  listAdminComplaints,
  listMessages,
  markRead,
  postMessage,
  updateComplaint,
} from "../services/complaints.service";

/*
 * =========================================================
 * Admin complaints API  (mounted at /admin/complaints)
 *
 * كل مسار بيتحقق من Firebase ID Token + دور الأدمن/الدعم + الصلاحية
 * المطلوبة (requirePermission). الأدمن بيتحدد من التوكن فقط.
 * =========================================================
 */

const router = Router();

function actorOf(staff: StaffContext | undefined): Actor {
  return { role: "admin", uid: staff!.uid, name: staff!.name };
}

/* ملاحظة اختيارية على الإغلاق/إعادة الفتح. */
function optionalNote(body: any): string | null {
  const raw = body && typeof body === "object" ? body.note : undefined;
  return raw !== undefined && raw !== null && String(raw).trim() !== ""
    ? parseMessageText({ text: raw })
    : null;
}

// GET /admin/complaints?status=&priority=&type=&q=&unread=1&page=&limit=
router.get("/", requirePermission("complaints.read"), async (req, res, next) => {
  try {
    const { page, limit } = parsePageParams(req.query as any);

    const result = await listAdminComplaints({
      status: qs(req.query.status),
      priority: qs(req.query.priority),
      type: qs(req.query.type),
      q: qs(req.query.q),
      unreadOnly: qs(req.query.unread) === "1" || qs(req.query.unread) === "true",
      page,
      limit,
    });

    res.json({ ok: true, ...result, counts: await getComplaintCounts() });
  } catch (err) {
    next(err);
  }
});

// GET /admin/complaints/stats
router.get("/stats", requirePermission("complaints.read"), async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await getComplaintCounts()) });
  } catch (err) {
    next(err);
  }
});

// GET /admin/complaints/:id
router.get("/:id", requirePermission("complaints.read"), async (req, res, next) => {
  try {
    res.json({ ok: true, complaint: await getComplaintForAdmin(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// GET /admin/complaints/:id/messages
router.get("/:id/messages", requirePermission("complaints.read"), async (req, res, next) => {
  try {
    await getComplaintForAdmin(req.params.id);

    const { page, limit } = parsePageParams({ page: req.query.page, limit: req.query.limit || 100 });

    res.json(await listMessages(req.params.id, "admin", page, limit));
  } catch (err) {
    next(err);
  }
});

// POST /admin/complaints/:id/messages — رد الأدمن على المستخدم
router.post("/:id/messages", requirePermission("complaints.reply"), async (req, res, next) => {
  try {
    const text = parseMessageText(req.body);

    const { duplicate, message } = await postMessage(actorOf(req.staff), req.params.id, text, {
      clientMessageId: parseClientMessageId(req.body),
    });

    res.status(duplicate ? 200 : 201).json(message);
  } catch (err) {
    next(err);
  }
});

// POST /admin/complaints/:id/request-info — طلب معلومات إضافية (الحالة → WAITING_FOR_USER)
router.post("/:id/request-info", requirePermission("complaints.reply"), async (req, res, next) => {
  try {
    const text = parseMessageText(req.body);

    const { duplicate, message } = await postMessage(actorOf(req.staff), req.params.id, text, {
      kind: "info_request",
      targetStatus: "WAITING_FOR_USER",
      clientMessageId: parseClientMessageId(req.body),
    });

    res.status(duplicate ? 200 : 201).json(message);
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/complaints/:id  { status?, priority?, note? }
router.patch("/:id", requirePermission("complaints.manage"), async (req, res, next) => {
  try {
    const input = parseComplaintUpdate(req.body);
    const complaint = await updateComplaint(actorOf(req.staff), req.params.id, input);

    res.json({ ok: true, complaint });
  } catch (err) {
    next(err);
  }
});

// POST /admin/complaints/:id/close  { note? }
router.post("/:id/close", requirePermission("complaints.manage"), async (req, res, next) => {
  try {
    const complaint = await updateComplaint(actorOf(req.staff), req.params.id, {
      status: "CLOSED",
      note: optionalNote(req.body),
    });

    res.json({ ok: true, complaint });
  } catch (err) {
    next(err);
  }
});

// POST /admin/complaints/:id/reopen  { note? }
router.post("/:id/reopen", requirePermission("complaints.manage"), async (req, res, next) => {
  try {
    const complaint = await updateComplaint(actorOf(req.staff), req.params.id, {
      status: "OPEN",
      note: optionalNote(req.body),
    });

    res.json({ ok: true, complaint });
  } catch (err) {
    next(err);
  }
});

// POST /admin/complaints/:id/read — الأدمن فتح الشكوى (بيصفّر عدّاد غير المقروء)
router.post("/:id/read", requirePermission("complaints.read"), async (req, res, next) => {
  try {
    res.json(await markRead("admin", req.staff!.uid, req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
