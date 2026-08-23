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
 * Normalizes phone numbers to standard format E.164 (+919876543210)
 * Handles raw inputs like: "9876543210", "+919876543210", "919876543210", "+91 98765 43210", " 9876543210 "
 */
const normalizePhone = (phone) => {
    if (!phone) return "";
    let cleaned = String(phone).trim().replace(/[^\d+]/g, '');
    if (/^[6-9]\d{9}$/.test(cleaned)) {
        cleaned = `+91${cleaned}`;
    } else if (/^91[6-9]\d{9}$/.test(cleaned)) {
        cleaned = `+${cleaned}`;
    } else if (!cleaned.startsWith('+') && cleaned.length >= 10) {
        cleaned = `+${cleaned}`;
    }
    return cleaned;
};


/**
 * Sends a 6-digit OTP via SMS
 * @param {string} phone  E.164 format, e.g. +919888109761
 * @returns {Promise<object>}
 */
const sendOtp = async (phone) => {
    if (!phone) throw new Error('Phone number is required');

    const formattedPhone = normalizePhone(phone);
    if (!formattedPhone) throw new Error('Invalid phone number format');

    const now = Date.now();
    const existing = otpStore.get(formattedPhone);

    // Rate-limit: 30 seconds between requests per number
    if (existing && (now - existing.lastSent < 30000)) {
        const remainingSeconds = Math.ceil((30000 - (now - existing.lastSent)) / 1000);
        throw new Error(`Please wait ${remainingSeconds} seconds before requesting a new OTP.`);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = now + (5 * 60 * 1000); // Strictly 5 minutes expiry

    // Store in memory (keyed by normalized phone number)
    otpStore.set(formattedPhone, {
        otp: String(otp).trim(),
        expires: expiry,
        lastSent: now
    });

    console.log(`🔑 [OTP Store] Generated OTP for ${formattedPhone}: ${otp} (Expires in 5 minutes)`);

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] OTP for ${formattedPhone} is: ${otp}`);
        console.log(`==================================================\n`);
        return { success: true, messageId: "dev-fallback-sid", isDevFallback: true, devOtp: otp };
    }

    try {
        const message = await client.messages.create({
            body: `Your Fine Bearing OTP is: ${otp}\nValid for 5 minutes. Do not share this code.`,
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
 * Verifies the OTP for a given phone number and CONSUMES it (one-time use).
 * Use this for final login/register actions.
 * @param {string} phone
 * @param {string} otp
 * @returns {boolean}
 */
const verifyOtp = (phone, otp) => {
    if (!phone || !otp) {
        console.log(`❌ [OTP Verify] Missing parameter: phone="${phone}", otp="${otp}"`);
        return false;
    }

    const formattedPhone = normalizePhone(phone);
    const inputOtpStr = String(otp).trim();

    console.log(`🔍 [OTP Verify] Looking up normalized phone: "${formattedPhone}" (raw: "${phone}")`);
    console.log(`🔍 [OTP Verify] OTP store has ${otpStore.size} entries. Keys: [${[...otpStore.keys()].join(', ')}]`);

    const storedData = otpStore.get(formattedPhone);
    if (!storedData) {
        console.log(`❌ [OTP Verify] No stored OTP found for "${formattedPhone}"`);
        return false;
    }

    const now = Date.now();
    const remainingMs = storedData.expires - now;
    console.log(`🔍 [OTP Verify] Found OTP for "${formattedPhone}". Expires in: ${Math.ceil(remainingMs / 1000)}s`);

    if (now > storedData.expires) {
        console.log(`❌ [OTP Verify] OTP expired for "${formattedPhone}". Expired at: ${new Date(storedData.expires).toISOString()}`);
        otpStore.delete(formattedPhone);
        return false;
    }

    const storedOtpStr = String(storedData.otp).trim();

    if (storedOtpStr === inputOtpStr) {
        console.log(`✅ [OTP Verify] OTP matched for "${formattedPhone}". Consuming (one-time use).`);
        otpStore.delete(formattedPhone); // One-time use: consume OTP
        return true;
    }

    console.log(`❌ [OTP Verify] Mismatch for "${formattedPhone}": Stored="${storedOtpStr}" vs Received="${inputOtpStr}"`);
    return false;
};

/**
 * Peeks at the OTP for a given phone — validates WITHOUT consuming it.
 * Use this only for a pre-check step (e.g. verify-otp-only before registration).
 * @param {string} phone
 * @param {string} otp
 * @returns {boolean}
 */
const peekOtp = (phone, otp) => {
    if (!phone || !otp) {
        console.log(`❌ [OTP Peek] Missing parameter: phone="${phone}", otp="${otp}"`);
        return false;
    }

    const formattedPhone = normalizePhone(phone);
    const inputOtpStr = String(otp).trim();

    console.log(`🔍 [OTP Peek] Checking (non-consuming) for "${formattedPhone}"`);

    const storedData = otpStore.get(formattedPhone);
    if (!storedData) {
        console.log(`❌ [OTP Peek] No stored OTP found for "${formattedPhone}"`);
        return false;
    }

    const now = Date.now();
    if (now > storedData.expires) {
        console.log(`❌ [OTP Peek] OTP expired for "${formattedPhone}".`);
        otpStore.delete(formattedPhone);
        return false;
    }

    const storedOtpStr = String(storedData.otp).trim();

    if (storedOtpStr === inputOtpStr) {
        console.log(`✅ [OTP Peek] OTP valid for "${formattedPhone}" (NOT consumed — still valid for final verification).`);
        return true;
    }

    console.log(`❌ [OTP Peek] Mismatch for "${formattedPhone}": Stored="${storedOtpStr}" vs Received="${inputOtpStr}"`);
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
    normalizePhone,
    sendOtp,
    verifyOtp,
    peekOtp,
    sendSMSOrderAlert,
    sendWhatsAppOrderAlert,
    sendAdminNewOrderAlert,
    sendPromotionalSMS,
    sendPromotionalWhatsApp
};