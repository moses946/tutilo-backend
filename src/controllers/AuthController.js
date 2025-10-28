import { createUserQuery } from "../models/query.js";
import admin, { db, verifyToken } from "../services/firebase.js"

export async function handleSignUp(req, res){
    // do some sanitization...
    try{
        let data = req.body;
        let token = req.headers.authorization.split(" ")[1];
        // get the token
        if(!token){
            res.status(400).json({error: 'Token is required'});
            return
        }
        let decoded = await verifyToken(token);
        if(!decoded){
            res.status(401).json({error: 'Invalid token'});
            return
        }
        console.log(decoded);
        // Prepare user data for database
        const userData = {
            email: data.email || decoded.email,
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            uid: decoded.uid,
            photoURL:data.photoURL || decoded.picture,
            onboardingData: data.onboardingData || null
        };
        console.log(userData);
        await createUserQuery(userData);
        res.json({message:'user created successfully'});
    }catch(err){
        console.log(`Error while creating user`);
        console.log(`ERROR:${err}`);
        res.status(500).json({error: 'Failed to create user'});
    }
}

export async function handleLogin(req, res){
    try{
        // decode the token
        let data = req.body
        if(!data.token){
            res.status(400).json({error: 'Token is required'});
            return
        }
        let decoded = await verifyToken(data.token);
        if(!decoded){
            res.status(401).json({error: 'Invalid token'});
            return
        }
        
        // Update user's last login timestamp
        let userRef = db.collection('User').doc(decoded.uid);
        await userRef.update({
            lastLogin: admin.firestore.FieldValue.serverTimestamp()
        });
        // Fetch user document and subscription status
        let userDoc = await userRef.get();
        let userData = userDoc.data();
        let subscription = userData && userData.subscription ? userData.subscription : null;
        console.log(`User sub:${subscription}`)
        res.json({
            message: 'Login successful',
            subscription: subscription
        });
    }catch(err){
        console.log('Error while logging user in');
        console.log(`ERROR:${err}`);
        res.status(500).json({error:'Error while logging user in'});
    }
}