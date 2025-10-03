import express, { text } from 'express';
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
var chatMap = new Map();

const chatRouter = express.Router();
chatRouter.get('/', handleReadChats);
chatRouter.post('/', handleCreateChat);
chatRouter.get('/:chatID', (req, res)=>{});
chatRouter.get('/:chatId/messages', handleReadMessages);
chatRouter.post('/:chatID/messages', upload.array('files'),handleCreateMessage);
chatRouter.patch('/:chatID/messages/:messageId', (req, res)=>{});
chatRouter.delete('/:chatID/messages/:messageId', (req, res)=>{});

async function handleCreateChat(req, res){
    // NOTE: MAKE SURE TO CHANGE THIS WHEN AUTH IS IMPLEMENTED
    // TODO: Replace with actual authentication middleware to set req.user
    const notebookID = req.body && req.body.notebookID ? req.body.notebookID : 'FhU4MBBq8YxZpSCS0tbl'
    let now = admin.firestore.FieldValue.serverTimestamp();
    const userId = req.user && req.user.uid ? req.user.uid : '7VMHj733cBO0KTSGsSPFlylJaHx1';
    const notebookRef = db.collection('Notebook').doc(notebookID);
    const userRef = db.collection('User').doc(userId);
    const chatRef = await db.collection('Chat').add({
        dateCreated:now,
        dateUpdated:now,
        notebookID:notebookRef,
        userID:userRef,
        title:'Default'
    });
    res.json(chatRef);
}

async function handleReadChats(req, res){
    try {
        // NOTE: MAKE SURE TO CHANGE THIS WHEN AUTH IS IMPLEMENTED
        // TODO: Replace with actual authentication middleware to set req.user
        const notebookID = req.query && req.query.notebookID ? req.query.notebookID : 'Tujqy9o16Ss4k9MiQ0uI';
        console.log('Fetching chats for notebookID:', notebookID);
        
        const notebookRef = db.collection('Notebook').doc(notebookID);
        const chatsRef = db.collection('Chat').where('notebookID', '==', notebookRef);
        console.log('Chats reference:', chatsRef);
        const chatsSnapshot = await chatsRef.get();
        
        const chats = chatsSnapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data()
        }));
        
        // Sort by dateUpdated on the client side to avoid Firestore index requirement
        chats.sort((a, b) => {
            const dateA = a.dateUpdated ? new Date(a.dateUpdated.seconds * 1000) : new Date(0);
            const dateB = b.dateUpdated ? new Date(b.dateUpdated.seconds * 1000) : new Date(0);
            return dateB - dateA; // Most recent first
        });
        
        console.log('Found chats:', chats.length);
        res.json(chats);
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Failed to fetch chats', message: error.message });
    }
}
export default chatRouter

// handle reading messages
async function handleCreateMessage(req, res){
    let result;
    try{// get the chat Id
        let now = admin.firestore.FieldValue.serverTimestamp();
        let data = req.body;
        console.log(`Data keys:${Object.keys(data)}`)
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
        let messageRef = await db.collection('Message').add({
            chatID:chatRef,
            content:JSON.stringify([{text:data.text}]),
            references:[],
            attachments:files?files.map((file)=>({type:file.mimetype, url:file.path})):[],
            role:'user',
            timestamp:now
        })
        console.log('Saved the message in firestore');
        // store the history text only, Will build the attachments for Gemini from the files field in the request
        let message = {role:'user', parts:[{text:data.text}]};
        // adding the message to history, because even if the AI generation fails the message will still be seen in history
        if (!chatMap.has(chatID)) chatMap.set(chatID, {history:[], chunks:{}});
        if (!Array.isArray(chatMap.get(chatID).history)){ 
            chatMap.delete(chatID);
            chatMap.set(chatID, {history:[], chunks:{}});
        }
        let obj = chatMap.get(chatID);
        obj.history.push(message);
        // chatMap[chatID] = {
        //     ...chatMap[chatID],
        //     history: [...chatMap[chatID].history, message]
        // };
        console.log("updated the history before calling agent");
        // run the AI agent to get the response
        result = await handleRunAgent(req, data, obj, chatRef);
        // the agent returns a JSON with {message:string}
        let aiMessageRef = await db.collection('Message').add({
            chatID:chatRef,
            content:JSON.stringify([{text:result.message}]),
            references:[],
            attachments:[],
            role:'model',
            timestamp:admin.firestore.FieldValue.serverTimestamp()
        })
    }catch(err){
        console.log(`Error occurred while creating message`);
        console.log(`ERROR:${err}`);
    }

    res.json(result)

}

async function handleReadMessages(req, res){
    console.log('Fetching messages');
    // build cache
    let chatID = req.params.chatID;
    // fetch the messages related to this ID
    let chatRef = db.collection('Chat').doc(chatID);
    let messageRefs = await db.collection('Message').where('chatID', '==', chatRef).orderBy('timestamp').get();
    let messages = [];
    messageRefs.forEach((doc)=>{
        const data = doc.data();
        messages.push({
            role:data.role,
            parts:JSON.parse(data.content)
        });
    })
    // add the messages to map
    let chatObj = chatMap.get(chatID);
    chatObj.history = messages;
    let messagesUser = messages.filter((message)=>message.role!=='system');
    res.json(messagesUser);
}
