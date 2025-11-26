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
        await createUserQuery(userData);
        res.json({message:'user created successfully'});
    }catch(err){
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
        
        // Fetch user document first to calculate streak
        let userDoc = await userRef.get();
        let userData = userDoc.data();
        
        let currentStreak = userData && userData.streak ? userData.streak : 0;
        let lastLogin = userData && userData.lastLogin ? userData.lastLogin.toDate() : null;
        
        let newStreak = 1; // Default for new users or reset
        
        if (lastLogin) {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const lastLoginDate = new Date(lastLogin.getFullYear(), lastLogin.getMonth(), lastLogin.getDate());
            
            const diffTime = Math.abs(today - lastLoginDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) {
                // Same day login, maintain streak
                newStreak = currentStreak;
            } else if (diffDays === 1) {
                // Consecutive day login, increment streak
                newStreak = currentStreak + 1;
            } else {
                // Missed a day (or more), reset streak
                newStreak = 1;
            }
        }

        await userRef.update({
            lastLogin: admin.firestore.FieldValue.serverTimestamp(),
            streak: newStreak
        });

        let subscription = userData && userData.subscription ? userData.subscription : 'free';
        // check if onboarding is done
        let isOnboardingComplete = userData && userData.isOnboardingComplete?true:false;
        
        // Fetch UserProfile to get theme preference
        let userProfileSnap = await db.collection('UserProfile')
            .where('userId', '==', userRef)
            .limit(1)
            .get();
        
        let theme = 'light'; // Default theme
        if (!userProfileSnap.empty) {
            const userProfileData = userProfileSnap.docs[0].data();
            theme = userProfileData?.preferences?.appPreferences?.theme || 'light';
        }
        
        console.log(`User sub:${subscription}, Streak: ${newStreak}, Theme: ${theme}`)
        res.json({
            message: 'Login successful',
            subscription: subscription,
            isOnboardingComplete,
            streak: newStreak,
            theme: theme
        });
    }catch(err){
        console.log('Error while logging user in');
        console.log(`ERROR:${err}`);
        res.status(500).json({error:'Error while logging user in'});
    }
}

export async function handleUpdateTheme(req, res){
    try{
        // decode the token
        let data = req.body;
        let authHeader = req.headers.authorization;
        
        if(!authHeader){
            res.status(401).json({error: 'Authorization header required'});
            return;
        }
        
        let parts = authHeader.split(' ');
        if(parts.length!==2||parts[0]!=='Bearer'){
            res.status(401).json({error:'Invalid Authorization'});
            return;
        }
        
        const token = parts[1];
        let decoded = await verifyToken(token);
        if(!decoded){
            res.status(401).json({error: 'Invalid token'});
            return;
        }
        
        // Validate theme value
        const { theme } = data;
        if(!theme || (theme !== 'light' && theme !== 'dark')){
            res.status(400).json({error: 'Invalid theme value. Must be "light" or "dark"'});
            return;
        }
        
        // Get UserProfile for this user
        let userRef = db.collection('User').doc(decoded.uid);
        let userProfileSnap = await db.collection('UserProfile')
            .where('userId', '==', userRef)
            .limit(1)
            .get();
        
        if (userProfileSnap.empty) {
            res.status(404).json({error: 'UserProfile not found'});
            return;
        }
        
        // Update theme preference
        const userProfileRef = userProfileSnap.docs[0].ref;
        const currentData = userProfileSnap.docs[0].data();
        
        await userProfileRef.update({
            preferences: {
                ...currentData.preferences,
                appPreferences: {
                    ...currentData.preferences?.appPreferences,
                    theme: theme
                }
            }
        });
        
        console.log(`Updated theme to ${theme} for user ${decoded.uid}`);
        res.json({
            message: 'Theme updated successfully',
            theme: theme
        });
    }catch(err){
        console.log('Error while updating theme');
        console.log(`ERROR:${err}`);
        res.status(500).json({error:'Error while updating theme'});
    }
}