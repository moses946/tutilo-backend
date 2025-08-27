import multer from 'multer';

// multer storage
const storage = multer.memoryStorage();
export const upload = multer({ storage });
