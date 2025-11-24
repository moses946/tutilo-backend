import { payStackURL } from "../config/config.js";

import dotenv from 'dotenv'
import admin, { db } from "../services/firebase.js";

dotenv.config();
export async function handleInitTransaction(req, res){
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
        // Map plan types to amounts (in kobo/cents)
        const planAmounts = {
            'plus': 50000,   // 500 NGN
            'pro': 150000 // 1500 NGN
        };

        const amount = planAmounts[plan];

        if (!amount) {
            return res.status(400).json({ message: 'Invalid subscription plan.' });
        }
        let response = await fetch(`${payStackURL}/transaction/initialize`, {
            method:'POST',
            headers:{
                // add the secret key in the environment variable
                'Authorization':`Bearer ${process.env.PAYSTACK_TEST_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body:JSON.stringify({
                email: email, 
                amount: JSON.stringify(amount)
            })
        });
        if(!response.ok){
            res.status(response.status).json({message:'transaction init failed'})
        }else{
            let result = await response.json();
            if(result.status&&result.data.access_code){
                res.status(response.status).json({message:result.message, status:result.status, accessCode:result.data.access_code})
            }
            
        }
    }catch(err){
        console.log(`[ERROR]:${err}`)
    }
}

export async function handleTransactionVerification(req, res){
    const { userID } = req.params;
    const { reference, plan } = req.body;
    
    if (!reference) {
        return res.status(400).json({ message: 'Transaction reference is required.' });
    }
    try {
        // 1. VERIFY THE TRANSACTION WITH PAYSTACK
        const paystackResponse = await fetch(`${payStackURL}/transaction/verify/${reference}`, {
            method:'GET',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_TEST_SECRET_KEY}`,
                'Content-Type':'application/json'
            }
        });
        const { status, data } = await paystackResponse.json();

        // 2. CHECK IF PAYSTACK CONFIRMS SUCCESS
        if (!status || data.status !== 'success') {
            return res.status(400).json({ message: 'Transaction verification failed.' });
        }
        
        // 3. (IMPORTANT) Check if the amount paid matches what you expected
        // The amount is in the smallest currency unit (e.g., kobo, cents)
        const expectedAmount = 500 * 100; // e.g., 500 NGN = 50000 kobo
        if (data.amount !== expectedAmount) {
             return res.status(400).json({ message: 'Invalid payment amount.' });
        }

        // 4. (Idempotency Check) Prevent re-processing the same transaction
        const transactionSnapshot = await db.collection('transaction').where('transactionReference', '==', reference).limit(1).get();
        if (!transactionSnapshot.empty) {
            return res.status(200).json({ message: 'Transaction already processed.' });
        }

        // 5. FULFILL THE ORDER (Your original logic)
        const tier = plan; // Determine tier based on amount or other data
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
        // custom claim to firebase so that i can verify in the frontend to render different UI
        await admin.auth().setCustomUserClaims(req.user.uid, {
            plan,
        })
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
