import { app } from "../services/firebase"

export const authMiddleWare = async(req, res, next)=>{
    let authHeader = req.headers.authorization;
    let parts = authHeader.split(' ');
    if(parts.length!==2||parts[0]!=='Bearer'){
        res.status(401).json({error:'Invalid Authorization'});
    }
    const token = parts[1];
    let idToken = await app.auth().verifyIdToken(token);
    req.user = idToken;
}