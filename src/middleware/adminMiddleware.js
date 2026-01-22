import { db, verifyToken } from "../services/firebase.js";

/**
 * Admin Middleware
 * Checks if the authenticated user has isAdmin: true in their User document.
 * Must be used AFTER authMiddleWare (requires req.user to be set).
 */
export const adminMiddleware = async (req, res, next) => {
    try {
        // Ensure user is authenticated first
        if (!req.user || !req.user.uid) {
            return res.status(401).json({ error: 'Unauthorized: Not authenticated' });
        }

        const userId = req.user.uid;
        const userDoc = await db.collection('User').doc(userId).get();

        if (!userDoc.exists) {
            return res.status(403).json({ error: 'Forbidden: User not found' });
        }

        const userData = userDoc.data();

        if (!userData.isAdmin) {
            return res.status(403).json({ error: 'Forbidden: Admin access required' });
        }

        // User is admin, proceed
        req.user.isAdmin = true;
        next();
    } catch (err) {
        console.error('[AdminMiddleware] Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
