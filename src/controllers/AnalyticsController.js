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