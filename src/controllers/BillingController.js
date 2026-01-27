import { payStackURL } from "../config/config.js";
import dotenv from 'dotenv'
import admin, { db } from "../services/firebase.js";
import crypto from 'crypto';

dotenv.config();

// Configuration for pricing across different currencies (Amounts in smallest unit)
const PRICING = {
    'plus': {
        'NGN': 50000,    // 500 Naira
        'KSH': 50000,    // 500 Shillings
        'USD': 500,      // $5.00
        'ZAR': 8000      // 80 Rand
    },
    'pro': {
        'NGN': 150000,   // 1500 Naira
        'KSH': 100000,   // 1,000 Shillings
        'USD': 1500,     // $15.00
        'ZAR': 24000     // 240 Rand
    }
};

// ============================================================================
// TRANSACTION INITIALIZATION
// ============================================================================

export async function handleInitTransaction(req, res) {
    try {
        // 1. Get currency from frontend (default to NGN if missing)
        const { email, plan, currency = 'NGN', userId } = req.body;

        // 2. Validate Plan
        if (!PRICING[plan]) {
            return res.status(400).json({ message: 'Invalid subscription plan.' });
        }

        // 3. Check existing subscription (prevent duplicates and handle upgrades)
        if (userId) {
            const userDoc = await db.collection('User').doc(userId).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                const currentPlan = userData.subscription || 'free';
                const subscriptionStatus = userData.subscriptionStatus;

                // Plan hierarchy for comparison
                const planRank = { 'free': 0, 'plus': 1, 'pro': 2 };

                // Block if already on this plan with active subscription
                if (currentPlan === plan && subscriptionStatus === 'active') {
                    return res.status(400).json({
                        message: `You already have an active ${plan} subscription.`
                    });
                }

                // Block downgrades via payment (should use cancel instead)
                if (planRank[plan] < planRank[currentPlan] && subscriptionStatus === 'active') {
                    return res.status(400).json({
                        message: `Cannot downgrade via payment. Please cancel your ${currentPlan} subscription first.`
                    });
                }

                console.log(`[Billing] User ${userId} upgrading from ${currentPlan} to ${plan}`);
            }
        }

        // 4. Determine Amount
        const amount = PRICING[plan][currency];
        if (!amount) {
            return res.status(400).json({ message: `Currency ${currency} not supported for this plan.` });
        }

        // 4. Determine available channels based on currency/region
        // Per Paystack docs: USSD=Nigeria, QR=South Africa, Bank=Nigeria, Mobile Money=GH/KE/CI
        const CURRENCY_CHANNELS = {
            'NGN': ['card', 'bank', 'ussd', 'bank_transfer'],
            'KSH': ['card', 'mobile_money', 'bank_transfer'],  // Kenya - M-PESA via mobile_money
            'USD': ['card'],
            'ZAR': ['card', 'qr'],  // South Africa
            'GHS': ['card', 'mobile_money'],  // Ghana
        };
        const channels = CURRENCY_CHANNELS[currency] || ['card'];

        // 5. Check for Subscription Mode (Plan IDs in .env)
        // naming convention: PAYSTACK_PLAN_PLUS_KSH, PAYSTACK_PLAN_PRO_USD, etc.
        const envPlanKey = `PAYSTACK_PLAN_${plan.toUpperCase()}_${currency}`;
        const paystackPlanCode = process.env[envPlanKey];

        // Debug logging
        console.log(`[Billing] Looking for env key: ${envPlanKey}`);
        console.log(`[Billing] Plan code found: ${paystackPlanCode || 'NOT FOUND - will be one-time payment'}`);

        const payload = {
            email: email,
            amount: amount,
            currency: currency === 'KSH' ? 'KES' : currency,  // Paystack uses KES for Kenya, not KSH
            channels: channels,
            metadata: {
                plan_type: plan,
                custom_fields: [
                    { display_name: "Plan Type", variable_name: "plan_type", value: plan },
                    { display_name: "Currency", variable_name: "currency", value: currency }
                ]
            }
        };

        // If a Plan Code exists, use it for Recurring Billing
        if (paystackPlanCode) {
            payload.plan = paystackPlanCode;
            console.log(`[Billing] Subscription mode: using plan ${paystackPlanCode}`);
        } else {
            console.log(`[Billing] One-time payment mode: no plan code in .env for ${envPlanKey}`);
        }

        // 5. Send Request to Paystack
        let response = await fetch(`${payStackURL}/transaction/initialize`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok) {
            console.error("Paystack Init Error:", result);
            return res.status(response.status).json({ message: result.message || 'Transaction init failed' });
        }

        res.status(200).json({
            message: result.message,
            status: result.status,
            accessCode: result.data.access_code,
            reference: result.data.reference
        });

    } catch (err) {
        console.error(`[Billing Init ERROR]: ${err}`);
        res.status(500).json({ message: 'Internal server error during payment initialization' });
    }
}

// ============================================================================
// TRANSACTION VERIFICATION
// ============================================================================

export async function handleTransactionVerification(req, res) {
    const { userID } = req.params;
    const { reference, plan } = req.body;

    if (!reference) {
        return res.status(400).json({ message: 'Transaction reference is required.' });
    }

    try {
        const paystackResponse = await fetch(`${payStackURL}/transaction/verify/${reference}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const result = await paystackResponse.json();
        const { status, data } = result;

        if (!status || data.status !== 'success') {
            return res.status(400).json({
                message: 'Transaction verification failed.',
                details: data?.gateway_response
            });
        }

        const now = admin.firestore.FieldValue.serverTimestamp();
        const userRef = db.collection('User').doc(userID);

        // Build update object for user
        const userUpdate = {
            subscription: plan,
            subscriptionStatus: 'active',
            subscriptionUpdated: now
        };

        // Store authorization details if card was used
        if (data.authorization && data.authorization.channel === 'card') {
            userUpdate.authorization = {
                authorization_code: data.authorization.authorization_code,
                last4: data.authorization.last4,
                exp_month: data.authorization.exp_month,
                exp_year: data.authorization.exp_year,
                card_type: data.authorization.card_type,
                bank: data.authorization.bank,
                brand: data.authorization.brand,
                reusable: data.authorization.reusable
            };
        }

        // Store Paystack customer code if present
        if (data.customer && data.customer.customer_code) {
            userUpdate.paystackCustomerCode = data.customer.customer_code;
        }

        // Store subscription code if this is a subscription transaction
        if (data.plan_object && data.plan_object.plan_code) {
            userUpdate.paystackPlanCode = data.plan_object.plan_code;
        }

        // Record transaction
        await db.collection('Transaction').add({
            user: userRef,
            userId: userID,
            tier: plan,
            transactionReference: data.reference,
            status: data.status,
            amount: data.amount,
            currency: data.currency,
            channel: data.channel,
            timestamp: now,
            isRecurring: !!data.plan
        });

        // Update user document
        await userRef.update(userUpdate);

        res.status(200).json({ message: 'Subscription updated successfully!', subscription: plan });

    } catch (err) {
        console.error(`[Billing Verify ERROR]: ${err}`);
        res.status(500).json({ message: 'Failed to verify payment', error: err.toString() });
    }
}

// ============================================================================
// PAYSTACK WEBHOOK HANDLER
// ============================================================================

export async function handlePaystackWebhook(req, res) {
    // 1. Verify HMAC signature
    const hash = crypto
        .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
        console.warn('[Webhook] Invalid signature');
        return res.sendStatus(401);
    }

    // 2. Return 200 immediately to prevent retries
    res.sendStatus(200);

    // 3. Process the event asynchronously
    const { event, data } = req.body;
    console.log(`[Webhook] Received event: ${event}`);

    try {
        switch (event) {
            case 'charge.success':
                await handleChargeSuccess(data);
                break;
            case 'subscription.create':
                await handleSubscriptionCreate(data);
                break;
            case 'subscription.disable':
            case 'subscription.not_renew':
                await handleSubscriptionDisable(data);
                break;
            case 'invoice.create':
                // Sent 3 days before a subscription charge - could send reminder email
                console.log(`[Webhook] Invoice created for customer: ${data.customer?.email}`);
                break;
            case 'invoice.update':
                // Handle failed charge or retry
                if (data.paid === false) {
                    await handleInvoiceFailed(data);
                }
                break;
            default:
                console.log(`[Webhook] Unhandled event: ${event}`);
        }
    } catch (err) {
        console.error(`[Webhook] Error processing ${event}:`, err);
    }
}

// Helper: Handle successful charge (recurring payment)
async function handleChargeSuccess(data) {
    const customerEmail = data.customer?.email;
    if (!customerEmail) return;

    // Find user by email
    const userSnapshot = await db.collection('User')
        .where('email', '==', customerEmail)
        .limit(1)
        .get();

    if (userSnapshot.empty) {
        console.warn(`[Webhook] No user found for email: ${customerEmail}`);
        return;
    }

    const userDoc = userSnapshot.docs[0];
    const userId = userDoc.id;
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Determine plan from metadata
    const planType = data.metadata?.plan_type || userDoc.data().subscription || 'plus';

    // Update user subscription status
    const updateData = {
        subscriptionStatus: 'active',
        subscriptionUpdated: now
    };

    // Update authorization if new card used
    if (data.authorization && data.authorization.reusable) {
        updateData.authorization = {
            authorization_code: data.authorization.authorization_code,
            last4: data.authorization.last4,
            exp_month: data.authorization.exp_month,
            exp_year: data.authorization.exp_year,
            card_type: data.authorization.card_type,
            bank: data.authorization.bank,
            brand: data.authorization.brand,
            reusable: data.authorization.reusable
        };
    }

    await db.collection('User').doc(userId).update(updateData);

    // Record transaction
    await db.collection('Transaction').add({
        user: db.collection('User').doc(userId),
        userId: userId,
        tier: planType,
        transactionReference: data.reference,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
        channel: data.channel,
        timestamp: now,
        isRecurring: true,
        source: 'webhook'
    });

    console.log(`[Webhook] Charge success processed for user: ${userId}`);
}

// Helper: Handle subscription creation
async function handleSubscriptionCreate(data) {
    const customerEmail = data.customer?.email;
    if (!customerEmail) return;

    const userSnapshot = await db.collection('User')
        .where('email', '==', customerEmail)
        .limit(1)
        .get();

    if (userSnapshot.empty) return;

    const userDoc = userSnapshot.docs[0];
    const nextPaymentDate = data.next_payment_date ? new Date(data.next_payment_date) : null;

    await db.collection('User').doc(userDoc.id).update({
        subscriptionCode: data.subscription_code,
        subscriptionEmailToken: data.email_token,  // IMPORTANT: Required for cancellation
        subscriptionStatus: 'active',
        nextBillingDate: nextPaymentDate ? admin.firestore.Timestamp.fromDate(nextPaymentDate) : null,
        paystackPlanCode: data.plan?.plan_code || null
    });

    console.log(`[Webhook] Subscription created for user: ${userDoc.id}, code: ${data.subscription_code}, email_token stored: ${!!data.email_token}`);
}

// Helper: Handle subscription cancellation/disable
async function handleSubscriptionDisable(data) {
    const subscriptionCode = data.subscription_code;
    if (!subscriptionCode) return;

    const userSnapshot = await db.collection('User')
        .where('subscriptionCode', '==', subscriptionCode)
        .limit(1)
        .get();

    if (userSnapshot.empty) {
        console.warn(`[Webhook] No user found with subscription code: ${subscriptionCode}`);
        return;
    }

    const userDoc = userSnapshot.docs[0];

    await db.collection('User').doc(userDoc.id).update({
        subscriptionStatus: 'cancelled',
        subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[Webhook] Subscription disabled for user: ${userDoc.id}`);
}

// Helper: Handle failed invoice (failed recurring charge)
async function handleInvoiceFailed(data) {
    const customerEmail = data.customer?.email;
    if (!customerEmail) return;

    const userSnapshot = await db.collection('User')
        .where('email', '==', customerEmail)
        .limit(1)
        .get();

    if (userSnapshot.empty) return;

    const userDoc = userSnapshot.docs[0];

    await db.collection('User').doc(userDoc.id).update({
        subscriptionStatus: 'attention' // Indicates payment issue
    });

    console.log(`[Webhook] Invoice failed for user: ${userDoc.id}, will retry`);
}

// ============================================================================
// GET SUBSCRIPTION DETAILS
// ============================================================================

export async function getSubscriptionDetails(req, res) {
    const { userID } = req.params;

    try {
        const userDoc = await db.collection('User').doc(userID).get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userData = userDoc.data();

        // Build response with subscription info
        const subscriptionDetails = {
            plan: userData.subscription || 'free',
            status: userData.subscriptionStatus || (userData.subscription && userData.subscription !== 'free' ? 'active' : 'none'),
            subscriptionCode: userData.subscriptionCode || null,
            nextBillingDate: userData.nextBillingDate ? userData.nextBillingDate.toDate().toISOString() : null,
            card: null
        };

        // Include masked card details if available
        if (userData.authorization) {
            subscriptionDetails.card = {
                last4: userData.authorization.last4,
                brand: userData.authorization.brand || userData.authorization.card_type,
                expMonth: userData.authorization.exp_month,
                expYear: userData.authorization.exp_year,
                bank: userData.authorization.bank
            };
        }

        res.status(200).json(subscriptionDetails);

    } catch (err) {
        console.error(`[Get Subscription ERROR]: ${err}`);
        res.status(500).json({ message: 'Failed to fetch subscription details' });
    }
}

// ============================================================================
// CANCEL SUBSCRIPTION
// ============================================================================

export async function cancelSubscription(req, res) {
    const { userID } = req.params;

    try {
        const userDoc = await db.collection('User').doc(userID).get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userData = userDoc.data();
        const subscriptionCode = userData.subscriptionCode;
        const emailToken = userData.subscriptionEmailToken;

        if (!subscriptionCode) {
            return res.status(400).json({ message: 'No active subscription found' });
        }

        if (!emailToken) {
            console.warn(`[Cancel] No email_token stored for user ${userID}. Subscription may have been created before token storage was implemented.`);
            return res.status(400).json({
                message: 'Cannot cancel: Missing email token. Please contact support.',
                debug: 'subscriptionEmailToken not stored for this user'
            });
        }

        console.log(`[Cancel] Attempting to disable subscription: code=${subscriptionCode}, token=${emailToken}`);

        // Call Paystack API to disable subscription
        const paystackResponse = await fetch(`${payStackURL}/subscription/disable`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                code: subscriptionCode,
                token: emailToken  // Use email_token, not authorization_code
            })
        });

        const result = await paystackResponse.json();

        if (!paystackResponse.ok) {
            console.error('[Cancel Subscription] Paystack error:', result);
            return res.status(400).json({
                message: result.message || 'Failed to cancel subscription on Paystack',
                paystackError: result
            });
        }

        // Update user document - subscription remains until end of billing period
        await db.collection('User').doc(userID).update({
            subscriptionStatus: 'non_renewing',
            subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`[Cancel] Subscription disabled successfully for user ${userID}`);

        res.status(200).json({
            message: 'Subscription cancelled successfully. Access continues until end of billing period.',
            status: 'non_renewing'
        });

    } catch (err) {
        console.error(`[Cancel Subscription ERROR]: ${err}`);
        res.status(500).json({ message: 'Failed to cancel subscription' });
    }
}

// ============================================================================
// ADMIN: CANCEL ANY USER'S SUBSCRIPTION
// ============================================================================

export async function adminCancelSubscription(req, res) {
    const { targetUserId } = req.params;
    const adminUserId = req.user?.uid; // From auth middleware

    try {
        // Verify requester is admin
        const adminDoc = await db.collection('User').doc(adminUserId).get();
        if (!adminDoc.exists || !adminDoc.data().isAdmin) {
            return res.status(403).json({ message: 'Admin access required' });
        }

        // Get target user
        const userDoc = await db.collection('User').doc(targetUserId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userData = userDoc.data();
        const subscriptionCode = userData.subscriptionCode;
        const emailToken = userData.subscriptionEmailToken;

        console.log(`[Admin Cancel] User: ${targetUserId}, SubscriptionCode: ${subscriptionCode}, EmailToken: ${emailToken ? 'present' : 'MISSING'}`);

        // If no subscription code, just reset their plan to free
        if (!subscriptionCode) {
            await db.collection('User').doc(targetUserId).update({
                subscription: 'free',
                subscriptionStatus: 'none',
                subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                subscriptionCancelledBy: adminUserId
            });

            return res.status(200).json({
                message: 'User plan reset to free (no subscription code found in database)',
                status: 'none',
                warning: 'No Paystack subscription was disabled - please verify manually in Paystack dashboard'
            });
        }

        // If no email token, we can't cancel via API
        if (!emailToken) {
            // Still update local DB but warn about Paystack
            await db.collection('User').doc(targetUserId).update({
                subscription: 'free',
                subscriptionStatus: 'cancelled',
                subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                subscriptionCancelledBy: adminUserId
            });

            return res.status(200).json({
                message: 'User plan reset to free, but Paystack subscription could NOT be disabled (missing email_token)',
                status: 'cancelled',
                warning: 'IMPORTANT: Please manually disable this subscription in Paystack dashboard to prevent future charges!',
                subscriptionCode: subscriptionCode
            });
        }

        // Call Paystack API to disable subscription
        console.log(`[Admin Cancel] Calling Paystack disable: code=${subscriptionCode}, token=${emailToken}`);

        const paystackResponse = await fetch(`${payStackURL}/subscription/disable`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                code: subscriptionCode,
                token: emailToken  // Use email_token from subscription creation
            })
        });

        const result = await paystackResponse.json();
        console.log(`[Admin Cancel] Paystack response:`, result);

        if (!paystackResponse.ok) {
            console.error('[Admin Cancel] Paystack error:', result);
            // Still update local DB
            await db.collection('User').doc(targetUserId).update({
                subscription: 'free',
                subscriptionStatus: 'cancelled',
                subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                subscriptionCancelledBy: adminUserId
            });

            return res.status(200).json({
                message: 'User plan reset to free, but Paystack returned an error',
                status: 'cancelled',
                warning: 'Please verify in Paystack dashboard that subscription is disabled',
                paystackError: result
            });
        }

        // Update user document
        await db.collection('User').doc(targetUserId).update({
            subscriptionStatus: 'cancelled',
            subscription: 'free',
            subscriptionCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            subscriptionCancelledBy: adminUserId
        });

        console.log(`[Admin] User ${adminUserId} cancelled subscription for ${targetUserId} - SUCCESS`);

        res.status(200).json({
            message: 'Subscription cancelled successfully on both database and Paystack',
            status: 'cancelled',
            paystackResult: result
        });

    } catch (err) {
        console.error(`[Admin Cancel Subscription ERROR]: ${err}`);
        res.status(500).json({ message: 'Failed to cancel subscription', error: err.message });
    }
}


// ============================================================================
// UPDATE PAYMENT CARD - Initialize new card authorization
// ============================================================================

export async function updatePaymentCard(req, res) {
    const { userID } = req.params;

    try {
        const userDoc = await db.collection('User').doc(userID).get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userData = userDoc.data();

        // Initialize a transaction for card update (small amount that gets refunded or zero-auth)
        // We use a minimal amount transaction to capture new card details
        const payload = {
            email: userData.email,
            amount: 5000, // 50 NGN - will be used to validate card, can be refunded
            currency: 'NGN',
            channels: ['card'],
            metadata: {
                purpose: 'card_update',
                user_id: userID,
                custom_fields: [
                    { display_name: "Purpose", variable_name: "purpose", value: "Card Update" }
                ]
            }
        };

        const response = await fetch(`${payStackURL}/transaction/initialize`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok) {
            return res.status(400).json({ message: result.message || 'Failed to initialize card update' });
        }

        res.status(200).json({
            message: 'Card update initialized',
            accessCode: result.data.access_code,
            reference: result.data.reference
        });

    } catch (err) {
        console.error(`[Update Card ERROR]: ${err}`);
        res.status(500).json({ message: 'Failed to initialize card update' });
    }
}

// ============================================================================
// VERIFY CARD UPDATE - Called after user completes card update popup
// ============================================================================

export async function verifyCardUpdate(req, res) {
    const { userID } = req.params;
    const { reference } = req.body;

    if (!reference) {
        return res.status(400).json({ message: 'Transaction reference is required.' });
    }

    try {
        const paystackResponse = await fetch(`${payStackURL}/transaction/verify/${reference}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const result = await paystackResponse.json();
        const { status, data } = result;

        if (!status || data.status !== 'success') {
            return res.status(400).json({
                message: 'Card update verification failed.',
                details: data?.gateway_response
            });
        }

        if (!data.authorization || data.authorization.channel !== 'card') {
            return res.status(400).json({ message: 'No card authorization found' });
        }

        // Update user's card details
        await db.collection('User').doc(userID).update({
            authorization: {
                authorization_code: data.authorization.authorization_code,
                last4: data.authorization.last4,
                exp_month: data.authorization.exp_month,
                exp_year: data.authorization.exp_year,
                card_type: data.authorization.card_type,
                bank: data.authorization.bank,
                brand: data.authorization.brand,
                reusable: data.authorization.reusable
            },
            cardUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // TODO: Optionally refund the 50 NGN validation charge
        // Can implement refund endpoint call here

        res.status(200).json({
            message: 'Card updated successfully!',
            card: {
                last4: data.authorization.last4,
                brand: data.authorization.brand,
                expMonth: data.authorization.exp_month,
                expYear: data.authorization.exp_year
            }
        });

    } catch (err) {
        console.error(`[Verify Card Update ERROR]: ${err}`);
        res.status(500).json({ message: 'Failed to verify card update' });
    }
}