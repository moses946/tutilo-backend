import { admin } from 'firebase-admin';

var serviceAccount = require('../secrets/tutilo-service-key.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

export default admin

