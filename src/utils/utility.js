import multer from 'multer';
import {bucket} from '../services/firebase'
// multer storage
const storage = multer.memoryStorage();
export const upload = multer({ storage });

const handleFileUpload = (file, path)=>{
    bucket.upload()
}
