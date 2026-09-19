import { Router } from "express";
import { db } from "../firebase";
import { requireAuth } from "../middleware/auth";
import { parsePageParams } from "../lib/pagination";
import {
  parseClientMessageId,
  parseMessageText,
  parseNewComplaint,
  toComplaintDto,
} from "../lib/complaints";
import {
  createComplaint,
  getOwnedComplaint,
  listMessages,
  listUserComplaints,
  markRead,
  postMessage,
} from "../services/complaints.service";

/*
 * =========================================================
 * User support API
 *
 * كل المسارات محمية بـ Firebase ID Token. المستخدم بيتحدد من
 * التوكن (req.userId) فقط — أي userId / role جاي في الجسم بيتتجاهل.
 * المستخدم بيشوف شكاويه فقط، وأي شكوى مش بتاعته بترجع 404.
 * =========================================================
 */

const router = Router();
router.use(requireAuth);

async function currentUserProfile(uid: string) {
  const doc = await db.collection("users").doc(uid).get();
  const d = doc.exists ? doc.data()! : {};

  return {
    uid,
    name: String(d.displayName || d.username || d.email || "مستخدم Gameora"),
    email: typeof d.email === "string" ? d.email : null,
  };
}

// POST /support/complaints — إنشاء شكوى جديدة
router.post("/complaints", async (req, res, next) => {
  try {
    const input = parseNewComplaint(req.body);
    const profile = await currentUserProfile(req.userId!);
    const complaint = await createComplaint(profile, input);

    res.status(201).json(complaint);
  } catch (err) {
    next(err);
  }
});

// GET /support/complaints — شكاوى المستخدم الحالي فقط
router.get("/complaints", async (req, res, next) => {
  try {
    const { page, limit } = parsePageParams(req.query as any);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    res.json(await listUserComplaints(req.userId!, { status, page, limit }));
  } catch (err) {
    next(err);
  }
});

// GET /support/complaints/:id
router.get("/complaints/:id", async (req, res, next) => {
  try {
    const doc = await getOwnedComplaint(req.userId!, req.params.id);

    res.json(toComplaintDto(doc.id, doc.data()!, "user"));
  } catch (err) {
    next(err);
  }
});

// GET /support/complaints/:id/messages
router.get("/complaints/:id/messages", async (req, res, next) => {
  try {
    await getOwnedComplaint(req.userId!, req.params.id);

    const { page, limit } = parsePageParams(req.query as any);

    res.json(await listMessages(req.params.id, "user", page, limit));
  } catch (err) {
    next(err);
  }
});

// POST /support/complaints/:id/messages — رد المستخدم
router.post("/complaints/:id/messages", async (req, res, next) => {
  try {
    const text = parseMessageText(req.body);
    const profile = await currentUserProfile(req.userId!);

    const { duplicate, message } = await postMessage(
      { role: "user", uid: profile.uid, name: profile.name },
      req.params.id,
      text,
      { clientMessageId: parseClientMessageId(req.body) }
    );

    res.status(duplicate ? 200 : 201).json(message);
  } catch (err) {
    next(err);
  }
});

// POST /support/complaints/:id/read — Mark as read
router.post("/complaints/:id/read", async (req, res, next) => {
  try {
    res.json(await markRead("user", req.userId!, req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
