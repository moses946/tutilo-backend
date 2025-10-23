import express from 'express';
import admin, { db } from '../services/firebase.js';

const billingRouter = express.Router();
billingRouter.get('/subscription', (req, res)=>{});
billingRouter.post('/transaction/initialize', handleInitTransaction);
billingRouter.post('/verify/:userID', handleTransactionVerification);
billingRouter.get('/webhooks', (req, res)=>{});

export default billingRouter

async function handleInitTransaction(req, res){
    try{
        // get user result
        /**
         * userData:object
         * {
        *   "email":string,
        *   "amount":number
         * } 
         */
        const { email, plan } = req.body;
        console.log(`plan:${plan}`);
        // Map plan types to amounts (in kobo/cents)
        const planAmounts = {
            'plus': 50000,   // 500 NGN
            'premium': 150000 // 1500 NGN
        };

        const amount = planAmounts[plan];

        if (!amount) {
            return res.status(400).json({ message: 'Invalid subscription plan.' });
        }
        console.log('hitting paystack endpoint');
        let response = await fetch("https://api.paystack.co/transaction/initialize", {
            method:'POST',
            headers:{
                // add the secret key in the environment variable
                'Authorization':'Bearer sk_test_d810930b536136b98eec3235be97570572bcf87b',
                'Content-Type': 'application/json'
            },
            body:JSON.stringify({
                email: email, 
                amount: JSON.stringify(amount)
            })
        });
        if(!response.ok){
            console.log(`Server was not ok with the request:${response.status}`)
            res.status(response.status).json({message:'transaction init failed'})
        }else{
            console.log('paystack responded')
            let result = await response.json();
            // keys: message, status, result
            // console.log(`Response:${result.message}`)
            // console.log(`Response:${result.status}`)
            // console.log(`Response:${result.data.access_code}`)
            // console.log(`Response fields: ${JSON.stringify(result.data)}`)
            if(result.status&&result.data.access_code){
                console.log('sending access code back to the user')
                res.status(response.status).json({message:result.message, status:result.status, accessCode:result.data.access_code})
            }
            
        }
    }catch(err){
        console.log(`[ERROR]:${err}`)
    }
}

async function handleTransactionVerification(req, res){
    const { userID } = req.params;
    const { reference } = req.body;

    if (!reference) {
        return res.status(400).json({ message: 'Transaction reference is required.' });
    }
    try {
        // 1. VERIFY THE TRANSACTION WITH PAYSTACK
        const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            method:'GET',
            headers: {
                'Authorization': `Bearer sk_test_d810930b536136b98eec3235be97570572bcf87b`,
                'Content-Type':'application/json'
            }
        });

        console.log(`Paystack verification`)
        console.log(paystackResponse.status)
        const { status, data } = await paystackResponse.json();

        // 2. CHECK IF PAYSTACK CONFIRMS SUCCESS
        if (!status || data.status !== 'success') {
            return res.status(400).json({ message: 'Transaction verification failed.' });
        }
        
        // 3. (IMPORTANT) Check if the amount paid matches what you expected
        // The amount is in the smallest currency unit (e.g., kobo, cents)
        const expectedAmount = 500 * 100; // e.g., 500 NGN = 50000 kobo
        if (data.amount !== expectedAmount) {
             console.log(`Tampering attempt! User ${userID} paid ${data.amount} but expected ${expectedAmount}`);
             return res.status(400).json({ message: 'Invalid payment amount.' });
        }

        // 4. (Idempotency Check) Prevent re-processing the same transaction
        const transactionSnapshot = await db.collection('transaction').where('transactionReference', '==', reference).limit(1).get();
        if (!transactionSnapshot.empty) {
            return res.status(200).json({ message: 'Transaction already processed.' });
        }

        // 5. FULFILL THE ORDER (Your original logic)
        const tier = 'plus'; // Determine tier based on amount or other data
        const now = admin.firestore.FieldValue.serverTimestamp();
        const userRef = db.collection('User').doc(userID);

        await db.collection('Transaction').add({
            user: userRef,
            tier: tier,
            transactionReference: data.reference,
            transactionNumber: data.id, // Use the ID from Paystack
            status: data.status,
            amount: data.amount,
        timestamp: now,
            createdAt: now
        });

        await userRef.update({ subscription: tier });

        res.status(200).json({ message: 'Subscription updated successfully!', subscription: tier });

    } catch (err) {
        console.error(`[ERROR while verifying purchase]: ${err}`);
        // Check if it's a Paystack API error or an internal one
        if (err.response) {
            console.error('Paystack API Error:', err.response.data);
        }
        res.status(500).json({ message: 'Failed to verify payment', error: err.toString() });
    }
}
// async function handleTransactionVerification(req, res){
//     let params = req.params;
//     let uid = params.userID;
//     let data = req.body;
//     let tier = data.tier;
//     let transactionReference = data.reference;
//     let transactionNumber = data.transactionNumber
//     try {
//         // Save the transaction in the "transaction" collection
//         let now = admin.firestore.FieldValue.serverTimestamp();
//         let userRef = db.collection('User').doc(uid);
//         await db.collection('transaction').add({
//             user: userRef,
//             tier: tier,
//             transactionReference: transactionReference || null,
//             transactionNumber: transactionNumber || null,
//             timestamp: now,
//             createdAt: now
//         });

//         await userRef.update({
//             subscription: tier
//         });
//         res.status(200).json({ message: 'Subscription updated', subscription: tier });
//     } catch (err) {
//         console.log(`[ERROR while updating subscription]:${err}`);
//         res.status(500).json({ message: 'Failed to update subscription', error: err.toString() });
//     }
// }
