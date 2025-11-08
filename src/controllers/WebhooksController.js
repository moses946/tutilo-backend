import { clientSocketsMap } from "../../index.js";
import { createMessageQuery } from "../models/query.js";
import { db } from "../services/firebase.js";
import { chatMap } from "./ChatController.js";

export async function videoReadyWebhook(req, res) {
    const { jobId, status, videoUrl, userID, messageID,errorLog } = req.body;
    console.log(`Received webhook for job ${jobId}: Status - ${status}: VideoURL - ${videoUrl}, userId:${userID}, messageId:${messageID}`);
    let client_sockets = clientSocketsMap.get(userID)
    let messageRef = db.collection('Message').doc(messageID)
    var aiMessageData = (await messageRef.get()).data()
    var aiMessage = JSON.parse(aiMessageData.content)[0]
    try{
        console.log(`Here is the socket:${client_sockets} -- message id:${messageID}`)
        // get the message ref and update
        if(errorLog && client_sockets){
            console.log(`Error from video_gen service:${errorLog}`);
            throw new Error('Video generation failed');
        }
        for(const socket of client_sockets){
            try{
                socket.send(JSON.stringify({event:'video-ready', message:{videoUrl, content:aiMessage.text}, status:200}))
            }catch(err){
                console.log(`[ERROR]:${err}`);
            }
        }
        await messageRef.update({attachments:[{mediaUrl:videoUrl, status:200}]})
    }catch(err){
        console.log(`[ERROR]:${err}`)
        if(client_sockets){           
            await messageRef.update({attachments:[{status:500, url:null}]});
            let chatRef = aiMessageData.chatID;
            let chatObj = chatMap.get(chatRef.id);
            chatObj.history.push({role:'system', parts:[{text:'Video generation has failed'}]});
            let data = {chatRef:chatRef,role:'system', content:[{text:'Video generation has failed'}]};
            await createMessageQuery(data)

            for(const socket of client_sockets){
                socket.send(JSON.stringify({event:'video-ready', message:{videoUrl}, status:500}))
            }
        }
    }
    
    // const jobInfo = jobs.get(jobId);

    // if (jobInfo) {
    //     // Find the user associated with this job
    //     const { userId } = jobInfo;

        // Use WebSockets, push notifications, or another method to notify the user
        // For example, using a simplified WebSocket emitter:
        // global.webSocketServer.to(userId).emit('video_ready', { status, videoUrl });
        
    console.log(`Notifying user  that their video is ready at ${videoUrl}`);
    
    
   

    res.status(200).send("Webhook received.");
};
