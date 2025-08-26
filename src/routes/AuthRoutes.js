const express = require("express");

const authRouter = express.Router();
authRouter.post('/signup', (req, res)=>{});
authRouter.post('/login', (req, res)=>{});
authRouter.post('logout', (req, res)=>{});

export default authRouter;