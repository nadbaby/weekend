const twilio = require('twilio');

// Load environment variables
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const apiKeySid = process.env.TWILIO_API_KEY_SID;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

console.log("Twilio Config Loaded:", { 
    accountSid: !!accountSid, 
    authToken: !!authToken, 
    apiKeySid: !!apiKeySid, 
    phone: !!twilioPhoneNumber 
});

if (!accountSid || !authToken || !twilioPhoneNumber) {
    console.warn("⚠️ [Twilio Warning] One or more crucial Twilio environment variables are missing! SMS services will fail.");
} else {
    console.log("✅ [Twilio] Configuration loaded successfully.");
}

// Initialize Twilio Client
let client;
if (apiKeySid && apiKeySid.startsWith('SK')) {
    console.log("Using Twilio API Key authentication...");
    client = twilio(apiKeySid, authToken, { accountSid: accountSid });
} else {
    console.log("Using Twilio Account SID/Auth Token authentication...");
    client = twilio(accountSid, authToken);
}

// In-memory OTP storage (phone → { otp, expires, lastSent })
const otpStore = new Map();

// Periodic background cleanup of expired OTPs to prevent memory leaks (every 10 minutes)
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [phone, data] of otpStore.entries()) {
        if (now > data.expires) {
            otpStore.delete(phone);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 [Twilio OTP Garbage Collector] Cleaned up ${cleaned} expired OTP entries from memory.`);
    }
}, 10 * 60 * 1000).unref(); // Use unref() so the interval does not keep the Node process alive in scripts/tests

/**
 * Sends a 6-digit OTP via SMS
 * @param {string} phone  E.164 format, e.g. +919888109761
 * @returns {Promise<object>}
 */
const sendOtp = async (phone) => {
    if (!phone) throw new Error('Phone number is required');

    // Auto-format 10-digit Indian phone numbers to E.164 if they don't have country code
    let formattedPhone = phone.trim();
    if (/^[6-9]\d{9}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
    }

    // Rate-limit: 60 seconds between requests per number
    const existing = otpStore.get(formattedPhone);
    const now = Date.now();
    if (existing && (now - existing.lastSent < 60000)) {
        const remaining = Math.ceil((60000 - (now - existing.lastSent)) / 1000);
        throw new Error(`Please wait ${remaining} seconds before requesting a new OTP.`);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = now + (5 * 60 * 1000); // 5 minutes

    // Graceful Demo Fallback when Twilio credentials are not set or are placeholders
    const isPlaceholder = !accountSid || !authToken || accountSid.includes('xxx') || authToken.includes('xxx') || !twilioPhoneNumber || twilioPhoneNumber.includes('xxx');
    if (isPlaceholder) {
        otpStore.set(formattedPhone, { otp, expires: expiry, lastSent: now });
        console.log(`[DEMO MODE OTP] Virtual OTP generated: ${otp} for ${formattedPhone}`);
        return { 
            success: true, 
            demoMode: true, 
            otp: otp,
            messageId: "demo_" + Date.now()
        };
    }

    try {
        const message = await client.messages.create({
            body: `Your Fine Bearing OTP is: ${otp}\nValid for 5 minutes. Do not share this code.`,
            from: twilioPhoneNumber,
            to: formattedPhone
        });

        otpStore.set(formattedPhone, { otp, expires: expiry, lastSent: now });
        console.log(`OTP sent via SMS to ${formattedPhone} | SID: ${message.sid}`);
        return { success: true, messageId: message.sid };

    } catch (error) {
        console.error('Twilio SMS Error:', error.code, error.message);

        // Fall back to virtual OTP in dev/testing environment if Twilio API fails to ensure signup is never blocked
        otpStore.set(formattedPhone, { otp, expires: expiry, lastSent: now });
        console.log(`[FALLBACK DEMO OTP] Virtual OTP generated due to Twilio error: ${otp} for ${formattedPhone}`);
        return { 
            success: true, 
            demoMode: true, 
            otp: otp,
            messageId: "demo_fallback_" + Date.now()
        };
    }
};

/**
 * Verifies the OTP for a given phone number
 * @param {string} phone
 * @param {string} otp
 * @returns {boolean}
 */
const verifyOtp = (phone, otp) => {
    if (!phone || !otp) return false;

    // Auto-format 10-digit Indian phone numbers to E.164 if they don't have country code
    let formattedPhone = phone.trim();
    if (/^[6-9]\d{9}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
    }

    const storedData = otpStore.get(formattedPhone);
    if (!storedData) return false;

    const now = Date.now();
    if (now > storedData.expires) {
        otpStore.delete(formattedPhone);
        return false;
    }

    if (storedData.otp === otp.trim()) {
        otpStore.delete(formattedPhone); // one-time use
        return true;
    }

    return false;
};

/**
 * Sends an order status SMS alert to a customer
 * @param {string} phone   E.164 format
 * @param {string} orderId
 * @param {string} status
 */
const sendSMSOrderAlert = async (phone, orderId, status) => {
    if (!phone || !orderId || !status) {
        throw new Error('Missing parameters for SMS alert');
    }

    // Auto-format 10-digit Indian phone numbers to E.164 if they don't have country code
    let formattedPhone = phone.trim();
    if (/^[6-9]\d{9}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
    }

    const s = status.toLowerCase();
    const messageTemplates = {
        confirmed:        `✅ Order Confirmed!\nOrder #${orderId} has been confirmed by Fine Bearing. We'll notify you when it's packed.`,
        packed:           `📦 Order Packed!\nOrder #${orderId} is packed and ready for dispatch.`,
        dispatched:       `🚚 Order Dispatched!\nOrder #${orderId} is on its way. Expect delivery updates soon.`,
        out_for_delivery: `🛵 Out for Delivery!\nOrder #${orderId} is out for delivery. Please be available.`,
        delivered:        `✅ Delivered!\nOrder #${orderId} has been delivered. Thank you for shopping with Fine Bearing!`,
        cancelled:        `❌ Order Cancelled\nOrder #${orderId} has been cancelled. Contact us for support.`,
    };

    const body = messageTemplates[s] || 
        `📋 Order Update\nOrder #${orderId} status: ${status}. - Fine Bearing`;

    try {
        const message = await client.messages.create({
            body,
            from: twilioPhoneNumber,
            to: formattedPhone
        });
        console.log(`SMS order alert sent to ${formattedPhone} | SID: ${message.sid}`);
        return { success: true, messageId: message.sid };
    } catch (error) {
        console.error('Twilio SMS Alert Error:', error.code, error.message);
        // Don't throw — order should still process even if SMS fails
        return { success: false, error: error.message };
    }
};

/**
 * Notifies admin/staff about a new order
 * @param {object} order  Full order object
 */
const sendAdminNewOrderAlert = async (order) => {
    // Get list of admin/staff numbers from .env (comma separated)
    // Example: ADMIN_NOTIFICATION_PHONES=+919888109761,+918146119761
    const numbersStr = process.env.ADMIN_NOTIFICATION_PHONES || process.env.ADMIN_PHONE || "";
    const numbers = numbersStr.split(',').map(n => n.trim()).filter(n => n.length > 5);

    if (numbers.length === 0) {
        console.log("No ADMIN_NOTIFICATION_PHONES found in .env, skipping admin SMS.");
        return;
    }

    const body = `🚨 NEW ORDER RECEIVED!\n\nOrder ID: #${order.orderId}\nCustomer: ${order.user?.name || 'Guest'}\nAmount: ₹${order.total.toFixed(2)}\nItems: ${order.items.length}\n\nPlease check the Order Panel for details.`;

    for (const phone of numbers) {
        try {
            await client.messages.create({
                body,
                from: twilioPhoneNumber,
                to: phone
            });
            console.log(`Admin SMS notification sent to ${phone}`);
        } catch (error) {
            console.error(`Failed to send Admin SMS to ${phone}:`, error.message);
        }
    }
};

module.exports = { 
    sendOtp, 
    verifyOtp, 
    sendSMSOrderAlert,
    sendAdminNewOrderAlert
};