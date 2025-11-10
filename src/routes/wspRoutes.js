// routes/waRoutes.js
import { Router } from "express";
import { decideAndSend } from "../controllers/wsp.controller.js";

const router = Router();
router.post("/webhook", decideAndSend);
export default router;
