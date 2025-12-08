import admin from 'firebase-admin';
import serviceAccount from '../secrets/tutilo-service-key.json' with { type: 'json' };

export const app = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // credential: admin.credential.applicationDefault(),
  storageBucket:'tutilo-beta.firebasestorage.app'
});

export default admin;

export const bucket = admin.storage().bucket();
export const db = admin.firestore();
export const auth = app.auth();
export const verifyToken = async (token) => {
  const decoded = await auth.verifyIdToken(token);
  if (!decoded) {
    return null
  } else {
    return decoded
  }
}

export const handleDeleteFirebaseAuthUser = async (userId) => {
  try {
    await admin.auth().deleteUser(userId);
    return {
      success: true,
      message: `User ${userId} deleted from Firebase Auth`
    };
  } catch (err) {
    console.error(`Failed to delete user ${userId} from Firebase Auth:`, err);
    return {
      success: false,
      error: err.message || 'Failed to delete Firebase Auth user'
    };
  }
}

