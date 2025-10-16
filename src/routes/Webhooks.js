import express from "express";
import { clientSocketsMap } from "../../index.js";
const webhookRouter = express.Router()

webhookRouter.use('/video-ready', videoReadyWebhook)

export function videoReadyWebhook(req, res) {
    const { jobId, status, videoUrl, userID, errorLog } = req.body;
    console.log(`Received webhook for job ${jobId}: Status - ${status}: VideoURL - ${videoUrl}, userId:${userID}`);
    let client_sockets = clientSocketsMap.get(userID)
    try{
        console.log(`Here is the socket:${client_sockets}`)
        if(errorLog && client_sockets){
            console.log(`generation failed:${errorLog}`);
            for(const socket of client_sockets){
                socket.send(JSON.stringify({event:'video-ready', message:videoUrl, status:500}))
            }
            return
        }
        for(const socket of client_sockets){
            socket.send(JSON.stringify({event:'video-ready', message:videoUrl, status:200}))
        }
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

export default webhookRouter