import admin, { db } from "../services/firebase.js";

export async function handleFeedbackSubmission(req, res) {
    try {
        const { rating, text, path } = req.body;
        const uid = req.user.uid;

        await db.collection('Feedback').add({
            userId: uid,
            rating: rating, // 1-5 scale
            text: text,
            path: path, // Which page they were on
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            status: 'new'
        });

        res.status(200).json({ message: 'Feedback received' });
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
}

export async function handleSessionLog(req, res) {
    try {
        const { durationSeconds } = req.body;
        const uid = req.user.uid;

        // You can store this in a 'Sessions' collection or aggregate it
        await db.collection('Sessions').add({
            userId: uid,
            durationSeconds: durationSeconds,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            date: new Date().toISOString().split('T')[0] // For easy daily querying
        });

        res.status(200).json({ message: 'Session logged' });
    } catch (err) {
        console.error('Session log error:', err);
        res.status(500).json({ error: 'Failed to log session' });
    }
}

// ============================================
// ADMIN ENDPOINTS (Requires adminMiddleware)
// ============================================

/**
 * Get aggregated token usage summary
 * Query params: 
 *   - startDate (ISO string, optional)
 *   - endDate (ISO string, optional)
 *   - userId (optional, filter by specific user)
 */
export async function handleGetTokenUsageSummary(req, res) {
    try {
        const { startDate, endDate, userId } = req.query;

        let query = db.collection('TokenUsage');

        // Apply date filters if provided
        if (startDate) {
            query = query.where('timestamp', '>=', new Date(startDate));
        }
        if (endDate) {
            query = query.where('timestamp', '<=', new Date(endDate));
        }
        if (userId) {
            query = query.where('userId', '==', userId);
        }

        const snapshot = await query.orderBy('timestamp', 'desc').limit(1000).get();

        // Aggregate by user
        // Aggregate by user
        const userAggregates = {};
        const featureAggregates = {};
        const dailyAggregates = {};

        snapshot.docs.forEach(doc => {
            const data = doc.data();
            // Handle userId being either a string or a Firestore reference
            let uid = data.userId;
            if (uid && typeof uid === 'object' && uid.id) {
                uid = uid.id; // Extract ID from Firestore reference
            } else if (uid && typeof uid === 'object' && uid._path) {
                uid = uid._path.segments?.[uid._path.segments.length - 1] || 'unknown';
            }
            uid = String(uid || 'unknown');

            const feature = data.feature || 'unknown';

            // User aggregation
            if (!userAggregates[uid]) {
                userAggregates[uid] = {
                    userId: uid,
                    totalInputTokens: 0,
                    totalOutputTokens: 0,
                    totalTokens: 0,
                    requestCount: 0
                };
            }
            userAggregates[uid].totalInputTokens += data.inputTokens || 0;
            userAggregates[uid].totalOutputTokens += data.outputTokens || 0;
            userAggregates[uid].totalTokens += data.totalTokens || 0;
            userAggregates[uid].requestCount += 1;

            // Feature aggregation
            if (!featureAggregates[feature]) {
                featureAggregates[feature] = {
                    feature,
                    totalTokens: 0,
                    requestCount: 0
                };
            }
            featureAggregates[feature].totalTokens += data.totalTokens || 0;
            featureAggregates[feature].requestCount += 1;
            // Daily aggregation
            const dateStr = data.timestamp?.toDate?.()?.toISOString()?.split('T')[0] || 'Unknown Date';
            if (!dailyAggregates[dateStr]) {
                dailyAggregates[dateStr] = {
                    date: dateStr,
                    totalTokens: 0,
                    requestCount: 0
                };
            }
            dailyAggregates[dateStr].totalTokens += data.totalTokens || 0;
            dailyAggregates[dateStr].requestCount += 1;
        });

        // Sort users by total tokens descending
        const userList = Object.values(userAggregates).sort((a, b) => b.totalTokens - a.totalTokens);
        const featureList = Object.values(featureAggregates).sort((a, b) => b.totalTokens - a.totalTokens);

        // Lookup emails for users (batch)
        const userIds = userList.map(u => u.userId).filter(id => id && id !== 'unknown');
        const userDocs = userIds.length > 0
            ? await Promise.all(userIds.slice(0, 50).map(id => db.collection('User').doc(id).get()))
            : [];

        const emailMap = {};
        userDocs.forEach(doc => {
            if (doc.exists) {
                const data = doc.data();
                emailMap[doc.id] = data.email || 'N/A';
            }
        });

        // Add email to user list
        userList.forEach(u => {
            u.email = emailMap[u.userId] || 'N/A';
        });

        res.json({
            totalRecords: snapshot.docs.length,
            byUser: userList,
            totalRecords: snapshot.docs.length,
            byUser: userList,
            byFeature: featureList,
            dailyUsage: Object.values(dailyAggregates).sort((a, b) => new Date(a.date) - new Date(b.date))
        });
    } catch (err) {
        console.error('[Admin] Token usage summary error:', err);
        res.status(500).json({ error: 'Failed to fetch token usage' });
    }
}

/**
 * Get list of all users with basic stats
 */
export async function handleGetAllUsersStats(req, res) {
    try {
        // Get all users
        const usersSnapshot = await db.collection('User')
            .where('isDeleted', '!=', true)
            .limit(500)
            .get();

        const users = [];

        for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data();

            // Get token usage count for this user
            const tokenSnapshot = await db.collection('TokenUsage')
                .where('userId', '==', userDoc.id)
                .count()
                .get();

            users.push({
                id: userDoc.id,
                email: userData.email || 'N/A',
                firstName: userData.firstName || '',
                lastName: userData.lastName || '',
                subscription: userData.subscription || 'free',
                isAdmin: userData.isAdmin || false,
                tokenRequestCount: tokenSnapshot.data().count,
                lastLogin: userData.lastLogin?.toDate?.()?.toISOString?.() || null,
                createdAt: userData.createdAt?.toDate?.()?.toISOString?.() || null
            });
        }

        // Sort by token usage
        users.sort((a, b) => b.tokenRequestCount - a.tokenRequestCount);

        res.json({ users, total: users.length });
    } catch (err) {
        console.error('[Admin] Get users stats error:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
}