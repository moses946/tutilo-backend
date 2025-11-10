import { createUserQuery } from "../models/query.js";
import admin, { db, verifyToken } from "../services/firebase.js"



export async function handleOnboarding(req, res){
    // do some sanitization...
    try{
        let data = req.body;
        let authHeader = req.headers.authorization;
        let parts = authHeader.split(' ');
        if(parts.length!==2||parts[0]!=='Bearer'){
            res.status(401).json({error:'Invalid Authorization'});
        }
        const token = parts[1];
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
        let displayName = (decoded.displayName || "").split(" ");
        const userData = {
            email: data.email || decoded.email,
            firstName: data.firstName || displayName[0] ||'',
            lastName: data.lastName || displayName[1] || '',
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
        
        // Get user reference
        let userRef = db.collection('User').doc(decoded.uid);
        // Fetch user document and subscription status
        let userDoc = await userRef.get();
        let userData = userDoc.data();

        // Streak logic implementation
        const now = new Date();
        const lastLogin = userData.lastLogin ? userData.lastLogin.toDate() : null;
        let streak = userData.streak || 0;

        if (lastLogin) {
            const lastLoginDate = new Date(lastLogin);
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const lastLoginDay = new Date(lastLoginDate.getFullYear(), lastLoginDate.getMonth(), lastLoginDate.getDate());

            const diffTime = today - lastLoginDay;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays === 1) {
                // User logged in yesterday, continue the streak
                streak++;
            } else if (diffDays > 1) {
                // User missed a day, reset the streak
                streak = 1;
            }
            // If diffDays is 0, user already logged in today, do nothing to the streak
        } else {
            // First login
            streak = 1;
        }

        // Update user's last login timestamp and streak
        await userRef.update({
            lastLogin: admin.firestore.FieldValue.serverTimestamp(),
            streak: streak
        });
        
        let subscription = userData && userData.subscription ? userData.subscription : 'free';
        // check if onboarding is done
        let isOnboardingComplete = userData && userData.isOnboardingComplete?true:false;
        console.log(`User sub:${subscription}`)
        console.log(`User streak:${streak}`);
        res.json({
            message: 'Login successful',
            subscription: subscription,
            isOnboardingComplete,
            streak: streak // Optionally return the new streak to the client
        });
    }catch(err){
        console.log('Error while logging user in');
        console.log(`ERROR:${err}`);
        res.status(500).json({error:'Error while logging user in'});
    }
}
// export async function handleLogin(req, res){
//     try{
//         // decode the token
//         let data = req.body
//         if(!data.token){
//             res.status(400).json({error: 'Token is required'});
//             return
//         }
//         let decoded = await verifyToken(data.token);
//         if(!decoded){
//             res.status(401).json({error: 'Invalid token'});
//             return
//         }
        
//         // Update user's last login timestamp
//         let userRef = db.collection('User').doc(decoded.uid);
//         // Fetch user document and subscription status
//         let userDoc = await userRef.get();
//         let userData = userDoc.data();
//         // get the last login
//         userData.lastLogin
//         await userRef.update({
//             lastLogin: admin.firestore.FieldValue.serverTimestamp()
//         });
        
//         let subscription = userData && userData.subscription ? userData.subscription : 'free';
//         // check if onboarding is done
//         let isOnboardingComplete = userData && userData.isOnboardingComplete?true:false;
//         console.log(`User sub:${subscription}`)
//         res.json({
//             message: 'Login successful',
//             subscription: subscription,
//             isOnboardingComplete
//         });
//     }catch(err){
//         console.log('Error while logging user in');
//         console.log(`ERROR:${err}`);
//         res.status(500).json({error:'Error while logging user in'});
//     }
// }