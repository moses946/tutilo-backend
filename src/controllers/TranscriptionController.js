import axios from 'axios';

const requestTranscriptionToken = async (req, res) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;

    if (!speechKey || !speechRegion) {
        return res.status(500).send('Error: Azure Speech keys are not configured on the server.');
    }

    // Azure Endpoint format: https://<region>.api.cognitive.microsoft.com/sts/v1.0/issueToken
    const tokenEndpoint = `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

    const headers = {
        'Ocp-Apim-Subscription-Key': speechKey,
        'Content-Type': 'application/x-www-form-urlencoded'
    };

    try {        
        // POST request to Azure to get the token
        const response = await axios.post(tokenEndpoint, null, { headers });
        
        // Send the Token and the Region back to the frontend
        res.send({ 
            token: response.data, 
            region: speechRegion 
        });

    } catch (error) {
        console.error('Azure Token Error:', error.response ? error.response.data : error.message);
        res.status(401).send('Error fetching speech token. Check your API Key and Region.');
    }
};

export default requestTranscriptionToken;