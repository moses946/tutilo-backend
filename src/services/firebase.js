import admin from 'firebase-admin';
import serviceAccount from '../secrets/tutilo-service-key.json' with { type: 'json' };

export const app = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket:'tutilo-c5698.firebasestorage.app'
});

export default admin;

export const bucket = admin.storage().bucket();
export const db = admin.firestore();



