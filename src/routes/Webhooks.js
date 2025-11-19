import express from "express";
import { videoReadyWebhook } from "../controllers/WebhooksController.js";

const webhookRouter = express.Router()

webhookRouter.use('/video-ready', videoReadyWebhook)


export default webhookRouter