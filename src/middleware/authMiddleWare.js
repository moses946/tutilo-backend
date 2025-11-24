import { app, db, verifyToken } from "../services/firebase.js"

export var userMap = new Map();
export const authMiddleWare = async(req, res, next)=>{
    try{
        let authHeader = req.headers.authorization;
        let parts = authHeader.split(' ');
        if(parts.length!==2||parts[0]!=='Bearer'){
            res.status(401).json({error:'Invalid Authorization'});
        }
        const token = parts[1];
        let idToken = await verifyToken(token);
        if(!idToken){
            res.status(401).json({message:'unauthorized'});
            return
        }
        
        // tried to do custom claims, but did not work 
        // let plan = idToken.claims ? idToken.claims.plan:'free'
        let userDoc = await db.collection('User').doc(idToken.uid).get();
        let userRef = userDoc.data();
        let plan = userRef && userRef.subscription ? userRef.subscription : 'free';
        req.user = {
            uid:idToken.uid,
            email:idToken.email,
            subscription:plan
        };
        let userObj = userMap.get(idToken.uid);
        if(!userObj){
            userMap.set(idToken.uid, {plan})
        }
    }catch(err){
        console.log('Error while verifying token', err);
        res.sendStatus(500)
        return
    }
    next();
}