import { clientSocketsMap } from "../../index.js";
import { agentLoop } from "../models/models.js";
import { createMessageQuery } from "../models/query.js";
import { db } from "../services/firebase.js";
import { chatMap } from "./ChatController.js";

export async function videoReadyWebhook(req, res) {
    const { jobId, status, videoUrl, userID, chatId, errorLog } = req.body;
    console.log(`Received webhook for job ${jobId}: Status - ${status}: VideoURL - ${videoUrl}, userId:${userID}, chatId:${chatId}`);
    let client_sockets = clientSocketsMap.get(userID)
    // get the chat ref
    let chatObj = chatMap.get(chatId);
    var chatRef = db.collection('Chat').doc(chatId);
    // create the function response part 
    var functionResponsePart;
    if(errorLog){
        functionResponsePart = {
            name: 'video_gen',
            response: {
              result: `video generation failed. [ERROR]:${errorLog}`,
            }
        };
    }else{
        console.log(`video gen status:${status}`);
        functionResponsePart = {
            name:'video_gen',
            response:{
                result:`video generation status:${status}`
            }
        }
    }
    let functionResponse = {
        role:'system',
        parts:[
            {
                functionResponse: functionResponsePart,
              },
        ]
    }
    await createMessageQuery({chatRef, content:functionResponsePart, role:'system'})
    chatObj.history.push(functionResponse)
    var response = await agentLoop(userID, chatObj, chatRef, [functionResponse])
    try{
        console.log(`Here is the socket:${client_sockets} -- message id:${chatId}`)
        // get the message ref and update
        if(errorLog && client_sockets){
            console.log(`Error from video_gen service:${errorLog}`);
            throw new Error('Video generation failed');
        }
        for(const socket of client_sockets){
            try{
                socket.send(JSON.stringify({event:'video-ready', message:{videoUrl, content:response.message}, status:200}))
            }catch(err){
                console.log(`[ERROR]:${err}`);
            }
        }
        await response.messageRef.update({attachments:[{mediaUrl:videoUrl, status:200}]})
    }catch(err){
        console.log(`[ERROR]:${err}`)
        if(client_sockets){           
            await response.messageRef.update({attachments:[{status:500, url:null}]});
            let chatObj = chatMap.get(chatRef.id);
            chatObj.history.push({role:'system', parts:[{text:response.message || 'Video gen has failed'}]});
            let data = {chatRef:chatRef,role:'system', content:[{text:response.message || 'Video gen has failed'}]};
            await createMessageQuery(data)

            for(const socket of client_sockets){
                socket.send(JSON.stringify({event:'video-ready', message:{videoUrl, content:response.message}, status:500}))
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
