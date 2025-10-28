import { clientSocketsMap } from "../../index.js";
import { db } from "../services/firebase.js";

export async function videoReadyWebhook(req, res) {
    const { jobId, status, videoUrl, userID, messageID,errorLog } = req.body;
    console.log(`Received webhook for job ${jobId}: Status - ${status}: VideoURL - ${videoUrl}, userId:${userID}`);
    let client_sockets = clientSocketsMap.get(userID)
    try{
        console.log(`Here is the socket:${client_sockets} -- message id:${messageID}`)
        // get the message ref and update
        let messageRef = db.collection('Message').doc(messageID)
        if(errorLog && client_sockets){
            console.log(`generation failed:${errorLog}`);
            for(const socket of client_sockets){
                try{
                    socket.send(JSON.stringify({event:'video-ready', message:videoUrl, status:500}))
                }catch(err){
                    console.log(`[ERROR]:${err}`);
                }
            }
            await messageRef.update({attachments:[{status:500, url:null}]})
            return
        }
        for(const socket of client_sockets){
            try{
                socket.send(JSON.stringify({event:'video-ready', message:videoUrl, status:200}))
            }catch(err){
                console.log(`[ERROR]:${err}`);
            }
        }
        await messageRef.update({attachments:[{mediaUrl:videoUrl, status:200}]})
    }catch(err){
        console.log(`[ERROR]:${err}`)
        console.log('Webhooks error')
        if(client_sockets){
            for(const socket of client_sockets){
                socket.send(JSON.stringify({event:'video-ready', message:videoUrl, status:500}))
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
