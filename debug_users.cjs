
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function countUsers() {
    try {
        console.log('Connecting to Firestore...');
        const usersSnapshot = await db.collection('User').get();
        console.log(`\n=== TOTAL USER DOCUMENTS: ${usersSnapshot.size} ===\n`);

        usersSnapshot.docs.forEach(doc => {
            const data = doc.data();
            console.log(`ID: ${doc.id}`);
            console.log(`Email: ${data.email}`);
            console.log(`isDeleted: ${data.isDeleted}`);
            console.log('---');
        });

    } catch (error) {
        console.error('Error counting users:', error);
    }
}

countUsers();
