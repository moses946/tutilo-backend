
import admin from 'firebase-admin';
import { readFile } from 'fs/promises';

const serviceAccount = JSON.parse(
    await readFile(new URL('./src/secrets/tutilo-service-key.json', import.meta.url))
);

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function countUsers() {
    try {
        const usersSnapshot = await db.collection('User').get();
        console.log(`COUNT: ${usersSnapshot.size}`);
    } catch (error) {
        console.error('Error counting users:', error);
    }
}

countUsers();
