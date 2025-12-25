import { app, db, verifyToken } from "../services/firebase.js"

export var userMap = new Map();
export const authMiddleWare = async(req, res, next)=>{
    try{
        let authHeader = req.headers.authorization;
        let parts = authHeader.split(' ');
        if(parts.length!==2||parts[0]!=='Bearer'){
            res.status(401).json({error:'Invalid Authorization'});
            return;
        }
        const token = parts[1];
        let idToken = await verifyToken(token);
        if(!idToken){
            res.status(401).json({message:'unauthorized'});
            return;
        }
        
        // tried to do custom claims, but did not work 
        // let plan = idToken.claims ? idToken.claims.plan:'free'
        let userDoc = await db.collection('User').doc(idToken.uid).get();
        let userProfileDoc = await db.collection('UserProfile').doc(idToken.uid).get();
        let userProfileRef = userProfileDoc.data();
        let userRef = userDoc.data();
        let plan = userRef && userRef.subscription ? userRef.subscription : 'free';
        let firstName = userRef && userRef.firstName ? userRef.firstName : '';
        let lastName = userRef && userRef.lastName ? userRef.lastName : '';
        let learningPreferences = {
            learningPath: userProfileRef.preferences.learningPath, 
            learningStyle: userProfileRef.preferences.learningStyle, // Can now be array
            learningContext: userProfileRef.preferences.learningContext || '' // New field
        }
        req.user = {
            uid:idToken.uid,
            email:idToken.email,
            subscription:plan,
            learningPreferences
        };
        let userObj = userMap.get(idToken.uid);
        if(!userObj){
            userMap.set(idToken.uid, {plan, learningPreferences, firstName, lastName})
        }
    }catch(err){
        console.log('Error while verifying token', err);
        res.sendStatus(500)
        return
    }
    next();
}