import express from "express";
import { handleLogin, handleSignUp } from "../controllers/AuthController.js";

const authRouter = express.Router();
authRouter.post('/signup', handleSignUp);
authRouter.post('/login', handleLogin);
// authRouter.post('logout', (req, res)=>{});

export default authRouter;



