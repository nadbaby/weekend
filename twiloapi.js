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

// Check if Twilio is properly configured (not using placeholders or empty values)
const isTwilioConfigured = !(
    !accountSid ||
    !authToken ||
    accountSid.includes('xxx') ||
    accountSid.includes('your_') ||
    authToken.includes('xxx') ||
    authToken.includes('your_') ||
    !twilioPhoneNumber ||
    twilioPhoneNumber.includes('xxx') ||
    twilioPhoneNumber.includes('your_')
);

// Initialize Twilio Client only if configured
let client;
if (isTwilioConfigured) {
    if (apiKeySid && apiKeySid.startsWith('SK')) {
        console.log("Using Twilio API Key authentication...");
        client = twilio(apiKeySid, authToken, { accountSid: accountSid });
    } else {
        console.log("Using Twilio Account SID/Auth Token authentication...");
        client = twilio(accountSid, authToken);
    }
} else {
    console.warn("⚠️ [Twilio Warning] Running in offline/development mode. SMS messages will be logged to the console.");
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

    // Rate-limit: 10 minutes between requests per number
    const existing = otpStore.get(formattedPhone);
    const now = Date.now();
    if (existing && (now - existing.lastSent < 600000)) {
        const remainingMinutes = Math.ceil((600000 - (now - existing.lastSent)) / 60000);
        throw new Error(`Please wait ${remainingMinutes} minutes before requesting a new OTP.`);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = now + (15 * 60 * 1000); // 15 minutes

    // Store OTP in memory first
    otpStore.set(formattedPhone, { otp, expires: expiry, lastSent: now });

    if (!isTwilioConfigured) {
        if (process.env.NODE_ENV !== "production") {
            console.log(`\n==================================================`);
            console.log(`[Twilio Dev Fallback] OTP for ${formattedPhone} is: ${otp}`);
            console.log(`==================================================\n`);
            return { success: true, messageId: "dev-fallback-sid", isDevFallback: true };
        } else {
            throw new Error("Twilio credentials are not configured properly in the server. Please check the .env file.");
        }
    }

    try {
        const message = await client.messages.create({
            body: `Your Fine Bearing OTP is: ${otp}\nValid for 15 minutes. Do not share this code.`,
            from: twilioPhoneNumber,
            to: formattedPhone
        });

        console.log(`OTP sent via SMS to ${formattedPhone} | SID: ${message.sid}`);
        return { success: true, messageId: message.sid };

    } catch (error) {
        console.error('Twilio SMS Error:', error.code, error.message);
        throw new Error(`Failed to send SMS: ${error.message}`);
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
        confirmed: `✅ Order Confirmed!\nOrder #${orderId} has been confirmed by Fine Bearing. We'll notify you when it's packed.`,
        packed: `📦 Order Packed!\nOrder #${orderId} is packed and ready for dispatch.`,
        dispatched: `🚚 Order Dispatched!\nOrder #${orderId} is on its way. Expect delivery updates soon.`,
        out_for_delivery: `🛵 Out for Delivery!\nOrder #${orderId} is out for delivery. Please be available.`,
        delivered: `✅ Delivered!\nOrder #${orderId} has been delivered. Thank you for shopping with Fine Bearing!`,
        cancelled: `❌ Order Cancelled\nOrder #${orderId} has been cancelled. Contact us for support.`,
    };

    const body = messageTemplates[s] ||
        `📋 Order Update\nOrder #${orderId} status: ${status}. - Fine Bearing`;

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] SMS Order Alert to ${formattedPhone}:`);
        console.log(body);
        console.log(`==================================================\n`);
        return { success: true, messageId: "dev-fallback-alert-sid" };
    }

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
 * Sends an order status WhatsApp alert to a customer
 * @param {string} phone   E.164 format
 * @param {string} orderId
 * @param {string} status
 */
const sendWhatsAppOrderAlert = async (phone, orderId, status) => {
    if (!phone || !orderId || !status) {
        throw new Error('Missing parameters for WhatsApp alert');
    }

    // Auto-format 10-digit Indian phone numbers to E.164 if they don't have country code
    let formattedPhone = phone.trim();
    if (/^[6-9]\d{9}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
    }

    const s = status.toLowerCase();
    const messageTemplates = {
        confirmed: `✅ *Order Confirmed!*\n\nOrder *#${orderId}* has been confirmed by *Fine Bearing*. We will notify you when it's packed. Thank you for shopping with us!`,
        packed: `📦 *Order Packed!*\n\nOrder *#${orderId}* is packed and ready for dispatch.`,
        dispatched: `🚚 *Order Dispatched!*\n\nOrder *#${orderId}* is on its way. Expect delivery updates soon.`,
        out_for_delivery: `🛵 *Out for Delivery!*\n\nOrder *#${orderId}* is out for delivery. Please be available to receive it.`,
        delivered: `✅ *Delivered!*\n\nOrder *#${orderId}* has been successfully delivered. Thank you for shopping with *Fine Bearing*!`,
        cancelled: `❌ *Order Cancelled*\n\nOrder *#${orderId}* has been cancelled. Please contact our support if you have any questions.`,
    };

    const body = messageTemplates[s] ||
        `📋 *Order Update*\n\nOrder *#${orderId}* status: *${status}*. - *Fine Bearing*`;

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] WhatsApp Order Alert to whatsapp:${formattedPhone}:`);
        console.log(body);
        console.log(`==================================================\n`);
        return { success: true, messageId: "dev-fallback-whatsapp-sid" };
    }

    const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER || "+14155238886";
    let whatsappSender = twilioWhatsAppNumber.trim();
    if (!whatsappSender.startsWith("whatsapp:")) {
        whatsappSender = `whatsapp:${whatsappSender}`;
    }

    try {
        const message = await client.messages.create({
            body,
            from: whatsappSender,
            to: `whatsapp:${formattedPhone}`
        });
        console.log(`WhatsApp order alert sent to ${formattedPhone} | SID: ${message.sid}`);
        return { success: true, messageId: message.sid };
    } catch (error) {
        console.error('Twilio WhatsApp Alert Error:', error.code, error.message);
        // Don't throw — order should still process even if WhatsApp fails
        return { success: false, error: error.message };
    }
};

/**
 * Notifies admin/staff about a new order
 * @param {object} order  Full order object
 */
const sendAdminNewOrderAlert = async (order) => {
    // Get list of admin/staff numbers from .env (comma separated)
    const numbersStr = process.env.ADMIN_NOTIFICATION_PHONES || process.env.ADMIN_PHONE || "";
    const numbers = numbersStr.split(',').map(n => n.trim()).filter(n => n.length > 5);

    if (numbers.length === 0) {
        console.log("No ADMIN_NOTIFICATION_PHONES found in .env, skipping admin SMS.");
        return;
    }

    const body = `🚨 NEW ORDER RECEIVED!\n\nOrder ID: #${order.orderId}\nCustomer: ${order.user?.name || 'Guest'}\nAmount: ₹${order.total.toFixed(2)}\nItems: ${order.items.length}\n\nPlease check the Order Panel for details.`;

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] Admin SMS Alert to ${numbers.join(', ')}:`);
        console.log(body);
        console.log(`==================================================\n`);
        return;
    }

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

/**
 * Sends a promotional SMS to a customer number
 * @param {string} phone 
 * @param {string} body 
 */
const sendPromotionalSMS = async (phone, body) => {
    if (!phone) throw new Error('Phone number is required');
    let formattedPhone = phone.trim();
    if (/^[6-9]\d{9}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
    }

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] Promotional SMS to ${formattedPhone}:`);
        console.log(body);
        console.log(`==================================================\n`);
        return { success: true, messageId: "dev-fallback-sms-sid" };
    }

    try {
        const response = await client.messages.create({
            body,  
            from: twilioPhoneNumber,
            to: formattedPhone
        });
        return { success: true, messageId: response.sid };
    } catch (error) {
        console.error('Twilio Promotional SMS Error:', error.message);
        throw error;
    }
};

/**
 * Sends a promotional WhatsApp message to a customer number
 * @param {string} phone 
 * @param {string} body 
 */
const sendPromotionalWhatsApp = async (phone, body) => {
    if (!phone) throw new Error('Phone number is required');
    let formattedPhone = phone.trim();
    if (/^[6-9]\d{9}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
    }

    // Twilio WhatsApp numbers require the "whatsapp:" prefix
    const toWhatsApp = `whatsapp:${formattedPhone}`;
    const fromWhatsApp = `whatsapp:${twilioPhoneNumber}`;

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] Promotional WhatsApp to ${formattedPhone}:`);
        console.log(body);
        console.log(`==================================================\n`);
        return { success: true, messageId: "dev-fallback-whatsapp-sid" };
    }

    try {
        const response = await client.messages.create({
            body,
            from: fromWhatsApp,
            to: toWhatsApp
        });
        return { success: true, messageId: response.sid };
    } catch (error) {
        console.error('Twilio Promotional WhatsApp Error:', error.message);
        throw error;
    }
};

module.exports = {
    sendOtp,
    verifyOtp,
    sendSMSOrderAlert,
    sendWhatsAppOrderAlert,
    sendAdminNewOrderAlert,
    sendPromotionalSMS,
    sendPromotionalWhatsApp
};