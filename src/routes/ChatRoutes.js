import express from 'express';
import admin, { db } from '../services/firebase.js';
import { handleRunAgent } from '../models/models.js';
import { handleBulkFileUpload, upload } from '../utils/utility.js';

// In memory chat map store
/* 
{
 [chatID]:chatObj
}
 chatObj -> {
    history:messages[],
    chunks:chunksObj
 }
 chunksObj -> {
    chunkID:concept
 }
*/
var chatMap = {}

const chatRouter = express.Router();
chatRouter.get('/', handleReadChats);
chatRouter.post('/', handleCreateChat);
chatRouter.get('/:chatID', (req, res)=>{});
// chatRouter.get('/:chatId/messages', (req, res)=>{});
chatRouter.post('/:chatID/messages', upload.array('files'),handleCreateMessage);
chatRouter.patch('/:chatID/messages/:messageId', (req, res)=>{});
chatRouter.delete('/:chatID/messages/:messageId', (req, res)=>{});

async function handleCreateChat(req, res){
    // NOTE: MAKE SURE TO CHANGE THIS WHEN AUTH IS IMPLEMENTED
    // TODO: Replace with actual authentication middleware to set req.user
    const notebookID = req.user && req.user.notebookID ? req.user.notebookID : 'OuNCbqVNBiEBZXgj1IZJ'
    let now = admin.firestore.FieldValue.serverTimestamp();
    const userId = req.user && req.user.id ? req.user.id : '7VMHj733cBO0KTSGsSPFlylJaHx1';
    const notebookRef = db.collection('Notebook').doc(notebookID);
    const userRef = db.collection('User').doc(userId);
    const chatRef = await db.collection('Chat').add({
        dateCreated:now,
        dateUpdated:now,
        notebookID:notebookRef,
        userID:userRef
    });
    res.json(chatRef);
}

async function handleReadChats(req, res){
    // NOTE: MAKE SURE TO CHANGE THIS WHEN AUTH IS IMPLEMENTED
    // TODO: Replace with actual authentication middleware to set req.user
    const userId = req.user && req.user.id ? req.user.id : '7VMHj733cBO0KTSGsSPFlylJaHx1';
    const userRef = db.collection('User').doc(userId);
    const chatsRef = db.collection('Chat').where('userID', '==', userRef).orderBy('dateUpdated').get()
    res.json((await chatsRef).docs.map((doc)=>(doc.data())));
}
export default chatRouter

// handle reading messages
async function handleCreateMessage(req, res){
    // get the chat Id
    let now = admin.firestore.FieldValue.serverTimestamp();
    let data = req.body;
    let chatID = req.params.chatID;
    let chatRef = db.collection('Chat').doc(chatID);
    // take the attachments and save in cloud storage
    let files;
    if(req.files){
        console.log(`Received ${req.files.length} files`);
        files = req.files;
        let attachmentBasePath = `notebooks/${data.notebookID}/chats/${chatID}`
        files = await handleBulkFileUpload(files, attachmentBasePath);
    }
    // create a message ref and add attachements
    let messageRef = db.collection('Message').add({
        chatID:chatRef,
        content:data.text,
        references:[],
        attachments:req.files?files.map((file)=>({type:file.mimetype, url:file.path})):[],
        role:'user',
        timestamp:now
    })
    console.log('Saved the message in firestore');
    // store the history text only, Will build the attachments for Gemini from the files field in the request
    let message = {role:'user', content:data.text};
    // adding the message to history, because even if the AI generation fails the message will still be seen in history
    if (!chatMap[chatID]) chatMap[chatID] = { history: [] };
    if (!Array.isArray(chatMap[chatID].history)) chatMap[chatID].history = [];
    chatMap[chatID] = {
        ...chatMap[chatID],
        history: [...chatMap[chatID].history, message]
    };
    console.log("updated the history before calling agent");
    // run the AI agent to get the response
    await handleRunAgent(req, data, chatMap[chatID]);
    res.json()

}
