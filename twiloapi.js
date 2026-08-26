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

// Security constants
const MAX_OTP_ATTEMPTS = 5;          // max wrong guesses before lockout
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes in ms
const OTP_TTL = 5 * 60 * 1000; // 5 minutes in ms
const RESEND_COOLDOWN = 30 * 1000;      // 30 seconds between resends

// In-memory OTP storage
// phone → { otp, expires, lastSent, nonce, attempts, lockedUntil }
const otpStore = new Map();

/**
 * Constant-time string comparison to prevent timing-based side-channel attacks.
 */
const safeEqual = (a, b) => {
    const sa = String(a);
    const sb = String(b);
    if (sa.length !== sb.length) return false;
    let diff = 0;
    for (let i = 0; i < sa.length; i++) {
        diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
    }
    return diff === 0;
};

// Periodic background cleanup (every 10 minutes)
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [phone, data] of otpStore.entries()) {
        // Keep locked entries until lockout expires, remove expired+unlocked entries
        const lockExpired = !data.lockedUntil || now > data.lockedUntil;
        const otpExpired = now > data.expires;
        if (otpExpired && lockExpired) {
            otpStore.delete(phone);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 [OTP GC] Cleaned up ${cleaned} expired OTP entries.`);
    }
}, 10 * 60 * 1000).unref();

/**
 * Returns true if the phone is currently locked out due to too many failed attempts.
 * @param {string} phone  raw or E.164 phone
 */
const isPhoneLocked = (phone) => {
    const formattedPhone = normalizePhone ? normalizePhone(phone) : phone;
    const entry = otpStore.get(formattedPhone);
    if (!entry || !entry.lockedUntil) return false;
    if (Date.now() < entry.lockedUntil) {
        const remainingSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
        console.log(`🔒 [OTP Lock] ${formattedPhone} is locked for ${remainingSec}s more.`);
        return { locked: true, remainingSec };
    }
    // Lockout expired — clear it
    otpStore.delete(formattedPhone);
    return false;
};

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

    // Reject if phone is currently locked out
    if (existing && existing.lockedUntil && now < existing.lockedUntil) {
        const remainingSec = Math.ceil((existing.lockedUntil - now) / 1000);
        throw new Error(`Too many failed attempts. Please try again in ${remainingSec} seconds.`);
    }

    // Rate-limit: enforce RESEND_COOLDOWN between send requests
    if (existing && (now - existing.lastSent < RESEND_COOLDOWN)) {
        const remainingSec = Math.ceil((RESEND_COOLDOWN - (now - existing.lastSent)) / 1000);
        throw new Error(`Please wait ${remainingSec} seconds before requesting a new OTP.`);
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const nonce = require('crypto').randomBytes(16).toString('hex'); // unique per OTP for anti-replay
    const expiry = now + OTP_TTL;

    // Store entry — reset attempts on new OTP request
    otpStore.set(formattedPhone, {
        otp: String(otp).trim(),
        nonce,
        expires: expiry,
        lastSent: now,
        attempts: 0,
        lockedUntil: null
    });

    console.log(`🔑 [OTP] Generated for ${formattedPhone} (expires ${new Date(expiry).toISOString()}, nonce: ${nonce.slice(0, 8)}...)`);

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] OTP for ${formattedPhone} is: ${otp}`);
        console.log(`==================================================\n`);
        return { success: true, messageId: 'dev-fallback-sid', isDevFallback: true, devOtp: otp };
    }

    try {
        const message = await client.messages.create({
            body: `Your Fine Bearing OTP is: ${otp}\nValid for 5 minutes. Do not share this code.`,
            from: twilioPhoneNumber,
            to: formattedPhone
        });
        console.log(`✅ [OTP] SMS sent to ${formattedPhone} | SID: ${message.sid}`);
        return { success: true, messageId: message.sid };
    } catch (error) {
        // Roll back the stored OTP so the user can retry immediately
        otpStore.delete(formattedPhone);
        console.error('❌ [Twilio] SMS Error:', error.code, error.message);
        throw new Error(`Failed to send SMS: ${error.message}`);
    }
};

/**
 * Internal helper — runs attempt tracking and lockout logic.
 * Returns { ok: true, nonce } on match, or { ok: false, reason } on failure.
 * @param {string} formattedPhone  Already-normalized E.164 phone
 * @param {string} inputOtp        Trimmed OTP string
 * @param {boolean} consume        If true, delete the entry on success (one-time use)
 */
const _checkOtp = (formattedPhone, inputOtp, consume) => {
    const storedData = otpStore.get(formattedPhone);

    if (!storedData) {
        console.log(`❌ [OTP] No entry for "${formattedPhone}"`);
        return { ok: false, reason: 'not_found' };
    }

    const now = Date.now();

    // Check lockout
    if (storedData.lockedUntil && now < storedData.lockedUntil) {
        const sec = Math.ceil((storedData.lockedUntil - now) / 1000);
        console.log(`🔒 [OTP] "${formattedPhone}" is locked for ${sec}s more.`);
        return { ok: false, reason: 'locked', remainingSec: sec };
    }

    // Check expiry
    if (now > storedData.expires) {
        console.log(`❌ [OTP] Expired for "${formattedPhone}".`);
        otpStore.delete(formattedPhone);
        return { ok: false, reason: 'expired' };
    }

    const storedOtp = String(storedData.otp).trim();

    // Constant-time comparison to prevent timing attacks
    if (safeEqual(storedOtp, inputOtp)) {
        const nonce = storedData.nonce;
        if (consume) {
            otpStore.delete(formattedPhone);
            console.log(`✅ [OTP] Matched & consumed for "${formattedPhone}".`);
        } else {
            console.log(`✅ [OTP] Matched (peek, not consumed) for "${formattedPhone}".`);
        }
        return { ok: true, nonce };
    }

    // Wrong OTP — increment attempt counter
    storedData.attempts = (storedData.attempts || 0) + 1;
    const attemptsLeft = MAX_OTP_ATTEMPTS - storedData.attempts;
    console.log(`❌ [OTP] Wrong OTP for "${formattedPhone}". Attempts: ${storedData.attempts}/${MAX_OTP_ATTEMPTS}`);

    if (storedData.attempts >= MAX_OTP_ATTEMPTS) {
        storedData.lockedUntil = now + LOCKOUT_DURATION;
        const lockMin = Math.ceil(LOCKOUT_DURATION / 60000);
        console.log(`🔒 [OTP] "${formattedPhone}" locked for ${lockMin} minutes after ${MAX_OTP_ATTEMPTS} failed attempts.`);
        return { ok: false, reason: 'locked', remainingSec: Math.ceil(LOCKOUT_DURATION / 1000) };
    }

    return { ok: false, reason: 'mismatch', attemptsLeft };
};

/**
 * Verifies OTP and CONSUMES it (one-time use). Use for login/register.
 * @param {string} phone
 * @param {string} otp
 * @returns {{ ok: boolean, reason?: string, nonce?: string }}
 */
const verifyOtp = (phone, otp) => {
    if (!phone || !otp) return { ok: false, reason: 'missing' };
    const formattedPhone = normalizePhone(phone);
    const inputOtp = String(otp).trim();
    console.log(`🔍 [OTP Verify] "${formattedPhone}" | store size: ${otpStore.size}`);
    return _checkOtp(formattedPhone, inputOtp, true /* consume */);
};

/**
 * Validates OTP WITHOUT consuming it (non-destructive peek).
 * Use for pre-registration check only. Always follow with verifyOtp or token-based flow.
 * @param {string} phone
 * @param {string} otp
 * @returns {{ ok: boolean, reason?: string, nonce?: string }}
 */
const peekOtp = (phone, otp) => {
    if (!phone || !otp) return { ok: false, reason: 'missing' };
    const formattedPhone = normalizePhone(phone);
    const inputOtp = String(otp).trim();
    console.log(`🔍 [OTP Peek] "${formattedPhone}"`);
    return _checkOtp(formattedPhone, inputOtp, false /* do not consume */);
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
/**
 * Notifies admin/staff about a new successful payment
 * @param {object} order  Full order object
 */
const sendAdminNewOrderAlert = async (order) => {
    const numbersStr = process.env.ADMIN_NOTIFICATION_PHONES || process.env.ADMIN_PHONE || "";
    const numbers = numbersStr.split(',').map(n => n.trim()).filter(n => n.length > 5);

    if (numbers.length === 0) {
        console.log("No ADMIN_NOTIFICATION_PHONES found in .env, skipping admin SMS.");
        return { success: false, reason: "No admin numbers configured" };
    }

    const formatCurrency = (amount) => `₹${Number(amount).toLocaleString('en-IN')}`;

    const body = `Hi Boss,
we got
New Payment of Order Received!

Order ID: #${order.orderId}
Customer: ${order.shippingAddress?.fullName || 'Guest'}
Amount: ${formatCurrency(order.total)}
Payment Status: SUCCESS
Transaction ID: ${order.paymentDetails?.transactionId || order.razorpayPaymentId || 'N/A'}

Please check the admin dashboard for complete order details.`;

    if (!isTwilioConfigured) {
        console.log(`\n==================================================`);
        console.log(`[Twilio Dev Fallback] Admin SMS Alert to ${numbers.join(', ')}:`);
        console.log(body);
        console.log(`==================================================\n`);
        return { success: true }; // Treat as dev success
    }

    let allFailed = true;
    for (const phone of numbers) {
        try {
            await client.messages.create({
                body,
                from: twilioPhoneNumber,
                to: phone
            });
            console.log(`Admin SMS notification sent to ${phone}`);
            allFailed = false;
        } catch (error) {
            console.error(`Failed to send Admin SMS to ${phone}:`, error.message);
        }
    }

    return { success: !allFailed };
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
    isPhoneLocked,
    sendSMSOrderAlert,
    sendWhatsAppOrderAlert,
    sendAdminNewOrderAlert,
    sendPromotionalSMS,
    sendPromotionalWhatsApp
};