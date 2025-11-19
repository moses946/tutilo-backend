import express from "express";
import { handleLogin, handleOnboarding} from "../controllers/AuthController.js";

const authRouter = express.Router();
authRouter.post('/onboarding', handleOnboarding);
authRouter.post('/login', handleLogin);
// authRouter.post('logout', (req, res)=>{});

export default authRouter;



