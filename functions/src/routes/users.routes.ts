import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getMe } from "./auth.routes";

const router = Router();

// GET /users/me
router.get("/me", requireAuth, getMe);

export default router;
