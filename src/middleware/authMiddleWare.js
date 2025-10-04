import { app, verifyToken } from "../services/firebase.js"

export const authMiddleWare = async(req, res, next)=>{
    try{
        let authHeader = req.headers.authorization;
        let parts = authHeader.split(' ');
        if(parts.length!==2||parts[0]!=='Bearer'){
            res.status(401).json({error:'Invalid Authorization'});
        }
        const token = parts[1];
        console.log(`Token:${token}`)
        let idToken = await verifyToken(token);
        if(!idToken){
            res.status(401).json({message:'unauthorized'});
            return
        }
        req.user = {
            uid:idToken.uid,
            email:idToken.email,
        };
    }catch(err){
        console.log('Error while verifying token');
        res.sendStatus(500)
        return
    }
    next();
}