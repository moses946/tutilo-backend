import express from "express";
import { createUserQuery } from "../models/query.js";
import admin, { db, verifyToken } from "../services/firebase.js";

const authRouter = express.Router();
authRouter.post('/signup', handleSignUp);
authRouter.post('/login', handleLogin);
authRouter.post('logout', (req, res)=>{});

export default authRouter;

async function handleSignUp(req, res){
    // do some sanitization...
    try{
        let data = req.body;
        // get the token
        if(!data.token){
            res.sendStatus(400);
            return
        }
        let decoded = verifyToken(data.token);
        if(!decoded){
            res.sendStatus(401);
            return
        }
        data.token = decoded;
        await createUserQuery(data);
        res.json({message:'user created'});
    }catch(err){
        console.log(`Error while creating user`);
        console.log(`ERROR:${err}`);
    }
}

async function handleLogin(req, res){
    try{
        // decode the token
        let data = req.body
        if(!data.token){
            res.sendStatus(400)
            return
        }
        let decoded = await verifyToken(token);
        if(!decoded){
            res.sendStatus(401);
            return
        }
        let userRef = db.collection('User').doc(decoded.uid);
        await userRef.update({
            lastLogin:admin.firestore.FieldValue.serverTimestamp()
        })
    }catch(err){
        console.log('Error while logging user in');
        console.log(`ERROR:${err}`);
        res.sendStatus(500);
    }
}