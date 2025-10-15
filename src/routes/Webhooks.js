import express from "express";
const webhookRouter = express.Router()

webhookRouter.use('/video-ready', videoReadyWebhook)

export function videoReadyWebhook(req, res) {
    const { jobId, status, videoUrl } = req.body;
    console.log(`Received webhook for job ${jobId}: Status - ${status}: VideoURL - ${videoUrl}`);

    // const jobInfo = jobs.get(jobId);

    // if (jobInfo) {
    //     // Find the user associated with this job
    //     const { userId } = jobInfo;

        // Use WebSockets, push notifications, or another method to notify the user
        // For example, using a simplified WebSocket emitter:
        // global.webSocketServer.to(userId).emit('video_ready', { status, videoUrl });
        
    console.log(`Notifying user  that their video is ready at ${videoUrl}`);
    
    jobs.delete(jobId); // Clean up the completed job
   

    res.status(200).send("Webhook received.");
};

export default webhookRouter