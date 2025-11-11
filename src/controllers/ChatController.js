import { handleRunAgent } from "../models/models.js";
import { createMessageQuery, deleteChatQuery } from "../models/query.js";
import admin, { bucket, db } from "../services/firebase.js";
import { handleBulkFileUpload } from "../utils/utility.js";

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
export var chatMap = new Map();

export async function handleCreateChat(req, res){
    try {
        const notebookID = req.body && req.body.notebookID ? req.body.notebookID : req.query?.notebookID;
        if (!notebookID) {
            return res.status(400).json({
                error: 'Notebook ID is required',
                message: 'Please provide notebookID in the body or query parameters',
            });
        }

        let now = admin.firestore.FieldValue.serverTimestamp();
        const userId = req.user && req.user.uid ? req.user.uid : '7VMHj733cBO0KTSGsSPFlylJaHx1';
        const notebookRef = db.collection('Notebook').doc(notebookID);
        const userRef = db.collection('User').doc(userId);
        const chatRef = await db.collection('Chat').add({
            dateCreated: now,
            dateUpdated: now,
            notebookID: notebookRef,
            userID: userRef,
            title: 'default',
        });

        const createdChat = await chatRef.get();
        res.json({ id: chatRef.id, ...createdChat.data() });
    } catch (error) {
        console.error('Error creating chat:', error);
        res.status(500).json({ error: 'Failed to create chat', message: error.message });
    }
}

export async function handleReadChats(req, res){
    try {
        // NOTE: MAKE SURE TO CHANGE THIS WHEN AUTH IS IMPLEMENTED
        // TODO: Replace with actual authentication middleware to set req.user
        const notebookID = req.query && req.query.notebookID ? req.query.notebookID : 'Tujqy9o16Ss4k9MiQ0uI';
        
        const notebookRef = db.collection('Notebook').doc(notebookID);
        const chatsRef = db.collection('Chat')
            .where('notebookID', '==', notebookRef)
            .orderBy('dateUpdated', 'desc');
        const chatsSnapshot = await chatsRef.get();
        
        const chats = chatsSnapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data()
        }));
        
        // console.log('Found chats:', chats.length);
        res.json(chats);
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Failed to fetch chats', message: error.message });
    }
}

export async function handleDeleteChat(req, res){
    try{
        let chatID = req.params.chatID;
        let {notebookID} = req.body;
        if(!notebookID){
            return res.status(400).json({message:'womp womp'})
        }
        // delete chat related stuff on db
        console.log(`Deleting chat query`);
        await deleteChatQuery(chatID);
        await bucket.deleteFiles({prefix:`notebooks/${notebookID}/chats/${chatID}/`})
        console.log(`Deleting bucket files`);
        res.status(200).json({message: 'Chat deleted successfully'});
    }catch(err){
        console.log(`[ERROR]:${err}`);
        return res.status(500).json({message:'Woopsies!'});
    }
}

export async function handleQuizRetrieval(req, res) {
    try {
        const { chatID } = req.params;
        const chatRef = db.collection('Chat').doc(chatID);
        const quizSnapshot = await db.collection('Quizzes')
            .where('chatID', '==', chatRef)
            .limit(1)
            .get();

        if (quizSnapshot.empty) {
            return res.status(404).json({
                error: 'Quiz not found',
                message: `No quiz found for chat ID: ${chatID}`
            });
        }

        const quizDoc = quizSnapshot.docs[0];
        res.json(quizDoc.data());
    } catch (err) {
        console.error('Error retrieving quiz:', err);
        res.status(500).json({
            error: 'Failed to retrieve quiz',
            details: err.message
        });
    }
}

// handle reading messages
export async function handleCreateMessage(req, res){
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
        createMessageQuery({chatRef, content:[{text:data.text}], role:'user', attachments:files})
        // store the history text only, Will build the attachments for Gemini from the files field in the request
        let message = {role:'user', parts:[{text:data.text}]};
        // adding the message to history, because even if the AI generation fails the message will still be seen in history
        if (!chatMap.has(chatID)){ 
            console.log('Map does not have the chatID');
            chatMap.set(chatID, {history:[], chunks:{}})
        };
        if (!Array.isArray(chatMap.get(chatID).history)){ 
            console.log('history is not an array')
            chatMap.delete(chatID);
            chatMap.set(chatID, {history:[], chunks:{}});
        }
        let obj = chatMap.get(chatID);
        // updating history before calling agent
        obj.history.push(message);
        // run the AI agent to get the response
        result = await handleRunAgent(req, data, obj, chatRef);
        // console.log('After agent: ', result.message)
        // the agent returns a JSON with {message:string}
        // createMessageQuery({chatRef, message:result.message, role:'model'})
    }catch(err){
        console.log(`Error occurred while creating message`);
        console.log(`ERROR:${err}`);
        res.status(500).json('Error while creating message');
    }

    res.json(result)

}

export async function handleReadMessages(req, res){
    // console.log('Fetching messages');
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
            parts:JSON.parse(data.content),
            attachments:data.attachments
        });
    })
    // add the messages to map
    let chatObj = chatMap.get(chatID);
    // console.log(chatObj)
    if(chatObj){
        chatObj.history = messages;
    }else{
        chatMap.set(chatID, {history:messages});
    }
    let messagesUser = messages.filter((message)=>message.role!=='system');
    res.json(messagesUser);
}
