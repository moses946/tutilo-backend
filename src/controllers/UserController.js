import { db } from "../services/firebase.js";

export const handleUpdateUser = async (req, res) => {
    try {
        const { userId } = req.params;
        const updates = req.body; // { firstName, lastName, phoneNumber, dateOfBirth }
        
        const userRef = db.collection('User').doc(userId);
        const batch = db.batch();

        // 1. Prepare User Collection Updates (Core Info)
        const userUpdates = {};
        if (updates.firstName !== undefined) userUpdates.firstName = updates.firstName;
        if (updates.lastName !== undefined) userUpdates.lastName = updates.lastName;

        if (Object.keys(userUpdates).length > 0) {
            batch.update(userRef, userUpdates);
        }

        // 2. Prepare UserProfile Collection Updates (Extended Info)
        const profileUpdates = {};
        if (updates.phoneNumber !== undefined) profileUpdates.phoneNumber = updates.phoneNumber;
        if (updates.dateOfBirth !== undefined) profileUpdates.dateOfBirth = updates.dateOfBirth;

        if (Object.keys(profileUpdates).length > 0) {
            // Find the profile document linked to this user
            const profileQuery = await db.collection('UserProfile')
                .where('userId', '==', userRef)
                .limit(1)
                .get();

            if (!profileQuery.empty) {
                // Update existing profile
                const profileDoc = profileQuery.docs[0].ref;
                batch.update(profileDoc, profileUpdates);
            } else {
                // Create profile if it doesn't exist (Handling legacy users)
                const newProfileRef = db.collection('UserProfile').doc();
                batch.set(newProfileRef, {
                    userId: userRef,
                    ...profileUpdates,
                    educationLevel: '',
                    location: '',
                    preferences: { appPreferences: { theme: "light" } },
                    profilePictureURL: "",
                    streak: { count: 0, lastDate: new Date() }
                });
            }
        }

        await batch.commit();

        res.status(200).json({ 
            message: 'Profile updated successfully',
            data: updates
        });

    } catch (err) {
        console.error('Error updating user profile:', err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
};

// ... keep existing get functions ...