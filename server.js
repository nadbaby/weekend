const path = require("path");
const dns = require("dns");
// Fix for MongoDB Atlas DNS resolution issues
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config();

// Global Exception and Rejection Handlers
process.on("uncaughtException", (error) => {
  console.error("❌ CRITICAL: Uncaught Exception detected:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ CRITICAL: Unhandled Rejection at:", promise, "reason:", reason);
});

// Strict JWT Secret Configuration Check
if (!process.env.JWT_SECRET) {
  console.error("❌ CRITICAL CONFIGURATION ERROR: JWT_SECRET environment variable is missing!");
  process.exit(1);
}
if (process.env.JWT_SECRET === "fallback_secret" || process.env.JWT_SECRET === "your_jwt_secret_here") {
  console.error("❌ CRITICAL CONFIGURATION ERROR: JWT_SECRET is set to a default placeholder value! Change it to a secure, random secret.");
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error("❌ CRITICAL CONFIGURATION ERROR: JWT_SECRET is too weak! It must be at least 32 characters long to be secure.");
  process.exit(1);
}

const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const connectDB = require("./config/db");
const axios = require("axios");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const useragent = require("express-useragent");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");
const Product = require("./models/Product");
const User = require("./models/User");
const Employee = require("./models/Employee");
const Order = require("./models/Order");
const Quote = require("./models/Quote");
const Ticket = require("./models/Ticket");
const Promotion = require("./models/Promotion");
const admin = require("firebase-admin");
const cloudinary = require("cloudinary").v2;
const { deleteFromCloudinary } = require("./config/cloudinary");
const compression = require("compression");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Cloudinary Health Check
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error("❌ CLOUDINARY ERROR: Missing configuration in environment variables!");
} else {
  console.log("✅ Cloudinary Config Loaded:", process.env.CLOUDINARY_CLOUD_NAME);
}

/**
 * Helper: Upload buffer to Cloudinary
 */
const uploadToCloudinary = (buffer, folder, resourceType = "auto") => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
};
const shippingRoutes = require("./routes/shipping");
const userRoutes = require("./routes/user");
const { detectZone, calculateCharges } = require("./services/shippingService");

// Initialize Firebase Admin (Unified for Auth & Storage)
if (!admin.apps.length) {
  try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }

    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: "finebear-bf157.appspot.com"
      });
      console.log("✅ Firebase Admin & Storage Initialized");
    } else {
      console.warn("⚠️ Firebase Admin credentials not found in env, skipping init.");
    }
  } catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
  }
}

// Fallback to avoid crashes if admin.storage() is called without init
const bucket = admin.apps.length > 0 ? admin.storage().bucket() : null;

const app = express();

// --- Start Server ---
const PORT = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Export for Vercel Serverless
module.exports = app;

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
  "https://tent-beta.vercel.app",
  "https://tent-nine.vercel.app",
  "https://finebearingonline.com",
  "https://www.finebearingonline.com",
  "https://finebearing.vercel.app",
  "https://fine-bearing.vercel.app"
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.includes("localhost") || origin.includes("127.0.0.1") || origin.includes("airoapp.ai")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

// --- Security Middleware Initialization ---
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(useragent.express());

// --- Request Logging (Debug) ---
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[API REQUEST] ${req.method} ${req.path} - Origin: ${req.headers.origin}`);
  }
  next();
});

// --- Bot Protection Middleware ---
app.use((req, res, next) => {
  // Bypass for local development
  if (req.headers.host && req.headers.host.includes('localhost')) return next();

  const ua = req.useragent;
  // Block common aggressive bots/scrapers if they identify themselves
  const suspiciousBots = ["curl", "python-requests", "postman", "insomnia"];
  const isBot = ua.isBot || suspiciousBots.some(bot => ua.source.toLowerCase().includes(bot));

  // Exception for search engines
  const searchEngines = ["google", "bing", "duckduckgo"];
  const isSearchEngine = searchEngines.some(engine => ua.source.toLowerCase().includes(engine));

  if (isBot && !isSearchEngine && req.path.startsWith('/api')) {
    logAudit("BOT_ACCESS_BLOCKED", "SYSTEM", { ua: ua.source, path: req.path });
    return res.status(403).json({ message: "Access denied: Bots are not permitted on API routes" });
  }
  next();
});

// --- Dynamic IP Blocklist ---
const blockedIPs = new Set(); // In production, load this from a DB or Redis
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (blockedIPs.has(ip)) {
    return res.status(403).json({ message: "Your IP has been blocked for suspicious activity" });
  }
  next();
});

// --- Cache Control Middleware ---
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.startsWith('/api')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  } else if (req.path.match(/\.(jpg|jpeg|png|gif|ico|css|js)$/)) {
    res.set('Cache-Control', 'public, max-age=31536000'); // 1 year cache for static assets
  }
  next();
});

app.use(cors(corsOptions));
app.use(express.json({
  limit: '1mb', // Restrict payload size for standard API routes to prevent memory exhaustion
  // Capture raw body for webhook verification
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/payment/webhook')) {
      req.rawBody = buf;
    }
  }
}));

// --- Data Sanitization ---
// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// Data sanitization against HTTP Parameter Pollution (HPP)
app.use(hpp());

// --- Rate Limiting ---
const isProduction = process.env.NODE_ENV === "production";

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 500 : 100000, // 500 in production, 100,000 in development/testing
  message: "Too many requests from this IP, please try again after 15 minutes"
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isProduction ? 20 : 10000, // 20 in production, 10,000 in development/testing
  message: "Too many login attempts, please try again after an hour"
});

app.use("/api/", globalLimiter);
app.use("/api/auth/login", authLimiter);

// Specialized limiter for payment creation (High Risk)
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: isProduction ? 30 : 5000, // 30 in production, 5000 in development/testing
  message: "Order frequency limit reached. Please wait a few minutes."
});
app.use("/api/payment/create-order", paymentLimiter);

// --- RBAC Middleware ---
const authorize = (roles = []) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    // Admin has access to everything
    if (req.user.role === 'admin') return next();

    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: Insufficient permissions" });
    }
    next();
  };
};

// --- Audit Logger Helper ---
const logAudit = async (action, userId, details) => {
  console.log(`[AUDIT LOG] ${new Date().toISOString()} | User: ${userId} | Action: ${action} | Details: ${JSON.stringify(details)}`);
  // Optionally save to a MongoDB AuditLog collection here
};

// --- Environment-Aware Error Response Helper ---
const sendErrorResponse = (res, error, defaultMessage = "An internal server error occurred") => {
  // Log the real error securely on the server console/logs
  console.error("Database/Server Error:", error);

  const isProd = process.env.NODE_ENV === "production";

  res.status(500).json({
    success: false,
    message: isProd ? defaultMessage : (error.message || defaultMessage),
    ...(isProd ? {} : { stack: error.stack, details: error })
  });
};

// --- Middleware ---

// Ensure DB is connected before any request
app.use(async (req, res, next) => {
  const success = await connectDB();
  if (!success && req.path.startsWith('/api')) {
    return res.status(503).json({
      message: "Database connection failed",
      error: "The server is temporarily unable to connect to the database. Please try again in a few seconds."
    });
  }
  next();
});

// auth middleware
const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // 1. Try Firebase Admin Verification
    try {
      const decodedFirebaseToken = await admin.auth().verifyIdToken(token);
      req.user = {
        uid: decodedFirebaseToken.uid,
        email: decodedFirebaseToken.email,
        firebase: true
      };
      return next();
    } catch (fbErr) {
      // If not a Firebase token, continue to legacy JWT check
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
};


// For Razorpay webhooks, we need the raw body for signature verification
// Increase body size limit for Base64 PDFs
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- NoSQL Injection Prevention Middleware ---
const sanitizeNoSql = (obj) => {
  if (obj && typeof obj === 'object') {
    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        // If nested object contains a key starting with $, delete the entire key
        const hasMongoOperator = Object.keys(obj[key]).some(k => k.startsWith('$'));
        if (hasMongoOperator) {
          delete obj[key];
        } else {
          sanitizeNoSql(obj[key]);
        }
      } else if (key.startsWith('$')) {
        delete obj[key];
      }
    }
  }
};

app.use((req, res, next) => {
  if (req.body) sanitizeNoSql(req.body);
  if (req.query) sanitizeNoSql(req.query);
  if (req.params) sanitizeNoSql(req.params);
  next();
});

app.use("/api/shipping", shippingRoutes);
app.use("/api/user", auth, userRoutes);
const multer = require("multer");
const { sendOtp, verifyOtp, sendSMSOrderAlert, sendWhatsAppOrderAlert, sendAdminNewOrderAlert, sendPromotionalSMS, sendPromotionalWhatsApp } = require("./twiloapi");

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});



// Helper: Upload to Firebase Storage
const uploadToFirebase = async (fileBuffer, fileName, folder = "catalogues") => {
  try {
    console.log(`Starting Firebase upload for: ${fileName}`);
    const file = bucket.file(`${folder}/${Date.now()}_${fileName}`);

    await file.save(fileBuffer, {
      metadata: {
        contentType: "application/pdf",
        cacheControl: 'public, max-age=31536000'
      }
    });

    // Try to make it public, but don't crash if it fails
    try {
      await file.makePublic();
    } catch (e) {
      console.warn("Could not make file public via ACL, using default access.");
    }

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;
    console.log(`✅ Upload successful: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error("❌ Firebase Helper Error:", error.message);
    throw error;
  }
};

// Image Upload Endpoint — uploads to Cloudinary
app.post("/api/upload", auth, upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }
  try {
    console.log("Attempting Cloudinary image upload...");
    const result = await uploadToCloudinary(req.file.buffer, "products", "image");
    console.log("✅ Cloudinary Image Upload Success:", result.secure_url);
    res.json({ filePath: result.secure_url, publicId: result.public_id });
  } catch (error) {
    console.error("❌ Cloudinary Image Upload Error:", error);
    sendErrorResponse(res, error, "Image upload failed");
  }
});

// Catalogue Upload (Simple Storage - 100% Reliable)
app.post("/api/upload-catalogue", auth, async (req, res) => {
  const { catalogueData, fileName } = req.body;
  if (!catalogueData) return res.status(400).json({ message: "No PDF data provided" });

  try {
    // We just return it for now so the frontend can save it to the product
    // Or we could save it to a separate collection. For simplicity, we'll let the frontend
    // handle the Base64 string since it's now part of the Product schema.
    res.json({ filePath: catalogueData, message: "PDF processed successfully" });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to process PDF");
  }
});


const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();

const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  })
  : null;

// --- Secure Total Calculation Helper ---
const calculateOrderTotal = async (cartItems, userId, reqBodyAddress = null, courierId = null, paymentMethod = "PREPAID", deliveryMethod = "STANDARD") => {
  const products = await Product.find({}).lean();
  const user = await User.findOne({
    $or: [
      { id: userId },
      { phone: userId },
      { username: userId },
      { firebaseUid: userId }
    ]
  }).lean();

  // Calculate subtotal from DB prices to prevent frontend price manipulation
  let subtotal = 0;
  const itemsWithDetails = cartItems.map(item => {
    // Force both to strings to ensure they match even if types differ
    const product = products.find(p => String(p.id) === String(item.id));
    if (!product) throw new Error(`Product with ID ${item.id} not found in database`);

    const itemTotal = product.price * item.quantity;
    subtotal += itemTotal;

    return {
      ...item,
      price: product.price,
      name: product.name,
      image: product.image, // SYNC PICTURES
      category: product.category,
      totalPrice: itemTotal
    };
  });

  // Apply user-specific discount from DB
  const discountPercent = user?.specialDiscount || 0;
  const discountAmount = (subtotal * discountPercent) / 100;

  const taxableAmount = subtotal - discountAmount;

  // --- Shipping Calculation Integration ---
  let shippingCharge = 0;
  let shippingDetails = null;

  if (deliveryMethod === "PORTER") {
    const totalWeight = itemsWithDetails.reduce((sum, item) => {
      const product = products.find(p => String(p.id) === String(item.id));
      return sum + ((product?.weightKg || 0) * item.quantity);
    }, 0);
    shippingCharge = 0;
    shippingDetails = {
      method: "PORTER",
      zone: "LOCAL/LUDHIANA",
      totalWeight: totalWeight,
      roundWeight: Math.ceil(totalWeight),
      message: "To be confirmed"
    };
  } else if (cartItems.length > 0 && reqBodyAddress) {
    try {
      // 1. Prepare items with dimensions for calculation
      const itemsForShipping = itemsWithDetails.map(item => {
        const product = products.find(p => String(p.id) === String(item.id));
        return {
          ...item,
          weightKg: product?.weightKg,
          dimensions: product?.dimensions,
          category: product?.category
        };
      });

      // 2. Detect zone and calculate full breakdown
      const zoneKey = await detectZone(reqBodyAddress.city, reqBodyAddress.state);
      const shippingResult = await calculateCharges(itemsForShipping, zoneKey, "PER_KG", taxableAmount, courierId, paymentMethod);

      shippingCharge = shippingResult.finalTotal;
      shippingDetails = {
        method: shippingResult.method,
        zone: shippingResult.zoneName,
        weights: shippingResult.weights,
        breakdown: shippingResult.breakdown,
        courier: shippingResult.courier,
        paymentMethod: shippingResult.paymentMethod,
        isFreeShippingApplied: shippingResult.isFreeShippingApplied,
        freeShippingReason: shippingResult.freeShippingReason
      };
    } catch (shippingErr) {
      console.error("Shipping calculation failed during order total check:", shippingErr);
    }
  }

  // Final Total calculation (tax is already included in shipping breakdown if needed, 
  // but let's keep consistency with items GST)
  const gstAmount = taxableAmount * 0.18; // 18% GST on items
  const finalTotal = Math.round(taxableAmount + gstAmount + shippingCharge);

  return {
    subtotal,
    discountAmount,
    taxableAmount,
    shippingCharge,
    shippingDetails,
    gstAmount,
    finalTotal,
    itemsWithDetails
  };
};

// login route for everyone
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ message: "Username and password are required" });
  }
  if (!password || typeof password !== "string" || !password.trim()) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  const trimmedUsername = username.trim();

  // 1. Check for Admin or Employee in MongoDB
  // We use a direct search which is much faster than RegExp
  const employee = await Employee.findOne({
    $or: [
      { username: trimmedUsername },
      { email: trimmedUsername }
    ],
    password: password
  }).collation({ locale: 'en', strength: 2 }).lean(); // strength 2 = case-insensitive

  if (employee) {
    const userRole = employee.role?.toLowerCase() || "employee";
    const token = jwt.sign({
      uid: employee.firebaseUid || employee.id || employee._id,
      username: employee.username,
      role: userRole,
      permissions: employee.permissions
    }, JWT_SECRET, { expiresIn: "3650d" });

    return res.json({
      token,
      user: { ...employee, role: userRole },
    });
  }

  // 2. Check for Normal User in MongoDB
  const user = await User.findOne({
    $or: [
      { phone: trimmedUsername },
      { username: trimmedUsername },
      { email: trimmedUsername }
    ]
  }).collation({ locale: 'en', strength: 2 }).lean();

  // If user exists, we check their password (if they have one)
  // Note: If your system uses OTP only for users, you should handle that separately
  if (user && user.password === password) {
    const token = jwt.sign({
      uid: user.firebaseUid || user.id || user._id,
      username: user.username || user.phone,
      role: "user"
    }, JWT_SECRET, { expiresIn: "3650d" });

    return res.json({
      token,
      user: { ...user, role: "user" },
    });
  }

  // 3. Reject if no match found
  return res.status(401).json({ message: "Invalid username or password" });
});


// 3. Get User Profile (Fast path after Firebase Login)
app.get("/api/auth/profile", auth, async (req, res) => {
  try {
    // Search in both collections by firebaseUid
    let profile = await Employee.findOne({ firebaseUid: req.user.uid }).lean();
    let type = "employee";

    if (!profile) {
      profile = await User.findOne({ firebaseUid: req.user.uid }).lean();
      type = "user";
    }

    if (!profile) {
      // Fallback: search by email if UID not linked yet
      profile = await Employee.findOne({ email: req.user.email }).lean();
      if (profile) {
        // Link it now for next time
        await Employee.updateOne({ _id: profile._id }, { firebaseUid: req.user.uid });
      } else {
        profile = await User.findOne({ email: req.user.email }).lean();
        if (profile) {
          await User.updateOne({ _id: profile._id }, { firebaseUid: req.user.uid });
        }
      }
    }

    if (!profile) {
      return res.status(404).json({ message: "Profile not found in database" });
    }

    res.json({ ...profile, type });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch profile");
  }
});

// Sync Firebase User with MongoDB
app.post("/api/auth/sync", auth, async (req, res) => {
  const { name, company, gstNumber } = req.body;
  const phone = (req.body.phone && req.body.phone.trim()) ? req.body.phone.trim() : undefined;
  console.log(`[SYNC] Attempting sync for UID: ${req.user.uid}, Email: ${req.user.email}`);

  if (!req.user || !req.user.uid) {
    return res.status(401).json({ message: "Invalid user session" });
  }

  try {
    // 1. Check if user exists in Employee collection (Admins/Staff)
    let user = await Employee.findOne({ firebaseUid: req.user.uid });
    if (!user && req.user.email) {
      user = await Employee.findOne({ email: req.user.email });
      if (user) {
        user.firebaseUid = req.user.uid;
        await user.save();
      }
    }

    // 2. If not an employee, check User collection (Customers)
    if (!user) {
      user = await User.findOne({ firebaseUid: req.user.uid });
      if (!user && req.user.email) {
        user = await User.findOne({ email: req.user.email });
        if (user) {
          user.firebaseUid = req.user.uid;
          if (name && !user.name) user.name = name;
          if (company && !user.company) user.company = company;
          if (req.body.gstNumber && !user.gstNumber) user.gstNumber = req.body.gstNumber;
          if (phone && !user.phone) user.phone = phone;
          await user.save();
        }
      }
    }

    // 3. If still not found, create a new customer
    if (!user) {
      // Prevent duplicate phone number crashes
      if (phone) {
        const existingPhone = await User.findOne({ phone });
        if (existingPhone) {
          return res.status(400).json({ message: "An account with this phone number already exists. Please log in using Phone OTP, or use a different phone number." });
        }
      }

      user = new User({
        id: "u_" + Date.now(),
        firebaseUid: req.user.uid,
        email: req.user.email || "",
        username: req.user.email?.split('@')[0] || "user_" + Date.now().toString().slice(-4),
        name: name || req.user.email?.split('@')[0] || "New User",
        company: company || "",
        gstNumber: req.body.gstNumber || "",
        phone: phone || undefined,
        role: "user"
      });
      await user.save();
    }

    const token = jwt.sign({
      uid: user.firebaseUid || user.id || user._id,
      username: user.username || user.phone || user.email,
      email: user.email,
      role: user.role || "user"
    }, JWT_SECRET, { expiresIn: "3650d" });

    res.json({
      success: true,
      message: "User synced successfully",
      user: user,
      token: token
    });
  } catch (err) {
    console.error("Sync Error:", err);
    sendErrorResponse(res, err, "Failed to sync user");
  }
});

// (Moved up)

// admin middleware
const adminOnly = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  // 1. Check if role is in token (Legacy)
  if (req.user.role === "admin") return next();

  // 2. If Firebase, check DB
  if (req.user.firebase) {
    try {
      const query = { $or: [{ firebaseUid: req.user.uid }] };
      if (req.user.email) query.$or.push({ email: req.user.email });

      const employee = await Employee.findOne(query);
      if (employee && employee.role?.toLowerCase() === "admin") {
        if (!employee.firebaseUid) {
          await Employee.updateOne({ id: employee.id }, { firebaseUid: req.user.uid });
        }
        req.user.role = "admin";
        return next();
      }
    } catch (err) { }
  }

  return res.status(403).json({ message: "Admin only" });
};

// admin or manager middleware
const adminOrManager = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  const isAllowedRole = (r) => ["admin", "manager"].includes(r?.toLowerCase());

  // 1. Check if role is in token (Legacy)
  if (isAllowedRole(req.user.role)) return next();

  // 2. If Firebase, check DB
  if (req.user.firebase) {
    try {
      const query = { $or: [{ firebaseUid: req.user.uid }] };
      if (req.user.email) query.$or.push({ email: req.user.email });

      const employee = await Employee.findOne(query);
      if (employee && isAllowedRole(employee.role)) {
        if (!employee.firebaseUid) {
          await Employee.updateOne({ id: employee.id }, { firebaseUid: req.user.uid });
        }
        req.user.role = employee.role.toLowerCase();
        return next();
      }
    } catch (err) { }
  }

  return res.status(403).json({ message: "Admin or Manager access only" });
};

// employee or admin middleware
const employeeOrAdmin = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  const isStaffRole = (r) => ["admin", "employee", "staff", "manager"].includes(r?.toLowerCase());

  // 1. Check legacy
  if (isStaffRole(req.user.role)) return next();

  // 2. Check Firebase in DB
  if (req.user.firebase) {
    try {
      const query = { $or: [{ firebaseUid: req.user.uid }] };
      if (req.user.email) query.$or.push({ email: req.user.email });

      const employee = await Employee.findOne(query);
      if (employee && isStaffRole(employee.role)) {
        if (!employee.firebaseUid) {
          await Employee.updateOne({ id: employee.id }, { firebaseUid: req.user.uid });
        }
        req.user.role = employee.role.toLowerCase();
        return next();
      }
    } catch (err) { }
  }

  res.status(403).json({ message: "Employee or Admin access only" });
};

// --- Twilio OTP Routes ---

// Send OTP
app.post("/api/auth/send-otp", async (req, res) => {
  const { phone } = req.body;
  console.log(`OTP Request for: ${phone}`);
  if (!phone) return res.status(400).json({ message: "Phone number is required" });

  try {
    const result = await sendOtp(phone);
    res.json(result);
  } catch (error) {
    console.error("Route OTP Error:", error.message);
    res.status(400).json({ message: error.message });
  }
});

// Verify OTP & Login
app.post("/api/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ message: "Phone and OTP are required" });

  const isValid = verifyOtp(phone, otp);
  if (!isValid) return res.status(401).json({ message: "Invalid or expired OTP" });

  // Generate token for the user
  const existingUser = await User.findOne({ phone }).lean();
  if (!existingUser) {
    return res.status(404).json({ message: "No account found with this phone number. Please sign up first." });
  }

  const token = jwt.sign({
    uid: existingUser.firebaseUid || existingUser.id || existingUser._id,
    username: phone,
    role: "user"
  }, JWT_SECRET, { expiresIn: "3650d" });

  res.json({
    success: true,
    token,
    user: existingUser
  });
});

// Standard Signup Route
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { username, password, email, phone, name, company } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    const existingUser = await User.findOne({ $or: [{ username }, { email }, { phone: phone || "" }] });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists with this username, email, or phone" });
    }

    const newUser = new User({
      id: "u_" + Date.now(),
      username,
      password, // In production, you should hash this!
      email,
      phone,
      name,
      company: company || "",
      role: "user"
    });

    await newUser.save();

    const token = jwt.sign({
      uid: newUser.firebaseUid || newUser.id || newUser._id,
      username,
      role: "user"
    }, JWT_SECRET, { expiresIn: "3650d" });

    res.status(201).json({
      success: true,
      token,
      user: newUser
    });
  } catch (error) {
    console.error("Signup error:", error);
    sendErrorResponse(res, error, "Failed to create user");
  }
});

// Verify OTP & Register (Updated with password support)
app.post("/api/auth/register-otp", async (req, res) => {
  const { phone, otp, name, company, password } = req.body;
  if (!phone || !otp || !name) {
    return res.status(400).json({ message: "Phone, OTP, and Name are required" });
  }

  const isValid = verifyOtp(phone, otp);
  if (!isValid) return res.status(401).json({ message: "Invalid or expired OTP" });

  const userExists = await User.findOne({ phone });
  if (userExists) {
    return res.status(400).json({ message: "This phone number already exists." });
  }

  const newUser = new User({
    id: "u_" + Date.now(),
    phone,
    name,
    password: password || "123456", // default password if not provided during OTP
    company: company || "",
    gstNumber: req.body.gstNumber || "",
    role: "user"
  });

  await newUser.save();

  const token = jwt.sign({
    uid: newUser.firebaseUid || newUser.id || newUser._id,
    username: phone,
    role: "user"
  }, JWT_SECRET, { expiresIn: "3650d" });

  res.json({ success: true, token, user: newUser });
});

// Media Proxy for Protected Images
app.get("/api/media/p/:id", async (req, res) => {
  try {
    const idParam = req.params.id;
    const productId = Number(idParam);
    console.log(`[MEDIA] Request for product ID: ${idParam} (Numeric: ${productId})`);

    let product = null;
    if (!isNaN(productId)) {
      product = await Product.findOne({ id: productId });
    }

    if (!product) {
      console.log(`[MEDIA] Product not found by numeric ID. Trying search...`);
      product = await Product.findOne({ $or: [{ sku: idParam }, { slug: idParam }] });
    }

    if (!product || !product.image) {
      console.log(`[MEDIA] Product or image not found for ID: ${idParam}`);
      return res.redirect("https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&q=80&w=600");
    }

    console.log(`[MEDIA] Redirecting to: ${product.image}`);
    res.redirect(product.image);
  } catch (error) {
    console.error("Media proxy error:", error);
    res.status(500).send("Error loading image");
  }
});

// --- SMS Routes ---

// Manual SMS Alert
app.post("/api/sms/order-alert", auth, employeeOrAdmin, async (req, res) => {
  const { phone, orderId, status } = req.body;
  if (!phone || !orderId || !status) {
    return res.status(400).json({ message: "Phone, orderId, and status are required" });
  }

  try {
    const result = await sendSMSOrderAlert(phone, orderId, status);
    res.json(result);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to send SMS alert");
  }
});

// AI Image search route (Visual Bearing Scanner)
app.post("/api/products/search-image", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No image file provided" });
  }

  try {
    const hasKey = !!process.env.GEMINI_API_KEY;
    if (!hasKey) {
      return res.status(500).json({ message: "Gemini AI is not configured" });
    }

    // 1. Convert file buffer to Gemini Part format
    const mimeType = req.file.mimetype === 'image/jpg' ? 'image/jpeg' : req.file.mimetype;
    const imagePart = {
      inlineData: {
        data: req.file.buffer.toString("base64"),
        mimeType: mimeType
      }
    };

    // 2. Fetch active products for catalog context
    const products = await Product.find({ isActive: true })
      .select('name category price sku brand keywords description')
      .lean();

    // Limit catalog context to keep token count reasonable
    const productContext = products.map(p =>
      `- SKU: ${p.sku} | Name: ${p.name} | Category: ${p.category} | Brand: ${p.brand} | Keywords: ${p.keywords || ''}`
    ).join('\n');

    // 3. Initialize Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    });

    const prompt = `You are an expert industrial engineering AI specialized in bearings and oil seals.
Your task is to identify the bearing or seal in the provided image and find the best matches from our catalog.

STEPS:
1. EXAMINE THE IMAGE closely. Look for and read any engraved or printed text, numbers, or codes (e.g., "6204", "ZZ", "2RS"). This text is the strongest indicator of the exact part!
2. Analyze the visual features: Is it a ball bearing, roller bearing, taper, or oil seal? Does it have rubber seals or metal shields?
3. Compare your findings against the AVAILABLE CATALOG below.
4. CRITICAL: If you read a specific part number in the image, you MUST prioritize matching catalog items that contain that number in their Name, SKU, or Keywords.
5. If no exact match is found, select the closest alternative based on visual type.

AVAILABLE CATALOG:
${productContext}

Respond strictly in valid JSON format. Do not write markdown blocks or any conversational text around the JSON.
Format the response exactly as follows:
{
  "detectedType": "Detailed name of detected part (e.g., Deep Groove Ball Bearing)",
  "reasoning": "Explain what text or visual features you observed in the image.",
  "matches": [
    {
      "sku": "SKU_OF_MATCH_1",
      "confidence": 95,
      "reason": "Explain exactly why this catalog item matches what you saw in the image."
    },
    {
      "sku": "SKU_OF_MATCH_2",
      "confidence": 75,
      "reason": "Another possible match."
    }
  ]
}`;

    let result;
    try {
      result = await model.generateContent([prompt, imagePart]);
    } catch (apiErr) {
      // Fallback to gemini-2.0-flash if the primary model is overloaded (503 Service Unavailable)
      if (apiErr.message && apiErr.message.includes("503")) {
        console.warn("Gemini 2.5 Flash is experiencing high demand. Falling back to Gemini 2.0 Flash...");
        const fallbackModel = genAI.getGenerativeModel({
          model: "gemini-2.0-flash",
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        });
        result = await fallbackModel.generateContent([prompt, imagePart]);
      } else {
        throw apiErr;
      }
    }
    const response = await result.response;
    const text = response.text();

    console.log("[AI Vision Search Response]:", text);

    // Clean JSON response (remove any markdown formatting if present)
    let cleanedText = text.trim();
    if (cleanedText.includes("```")) {
      const match = cleanedText.match(/```(?:json)?([\s\S]*?)```/);
      if (match) {
        cleanedText = match[1].trim();
      }
    }

    try {
      const jsonResponse = JSON.parse(cleanedText);
      res.json(jsonResponse);
    } catch (parseErr) {
      console.error("Failed to parse Gemini response as JSON:", text);
      res.status(500).json({
        message: "Failed to parse AI response as JSON",
        rawText: text,
        error: parseErr.message
      });
    }
  } catch (error) {
    console.error("AI vision search failed:", error);
    sendErrorResponse(res, error, "AI vision search failed");
  }
});


app.get("/api/products/autocomplete", async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!query) {
      return res.json({ suggestions: [], products: [] });
    }

    const words = query.split(/\s+/).filter(Boolean);
    const searchConditions = words.map(word => ({
      $or: [
        { name: { $regex: word, $options: "i" } },
        { sku: { $regex: word, $options: "i" } },
        { brand: { $regex: word, $options: "i" } },
        { category: { $regex: word, $options: "i" } },
        { subcategory: { $regex: word, $options: "i" } },
        { keywords: { $regex: word, $options: "i" } }
      ]
    }));

    const rawProducts = await Product.find({
      isActive: { $ne: false },
      $and: searchConditions
    })
      .select("id name sku brand category subcategory keywords image price")
      .limit(150)
      .lean();

    // Sort by relevance score
    const getRelevanceScore = (p, q) => {
      const qLower = q.toLowerCase();
      let score = 0;

      const name = (p.name || "").toLowerCase();
      const category = (p.category || "").toLowerCase();
      const subcategory = (p.subcategory || "").toLowerCase();
      const sku = (p.sku || "").toLowerCase();
      const brand = (p.brand || "").toLowerCase();

      // Name matches (highest priority)
      if (name === qLower) {
        score += 1000;
      } else if (name.startsWith(qLower)) {
        score += 500;
      } else if (name.includes(qLower)) {
        score += 200;
      }

      // Category & Subcategory matches
      if (category === qLower || subcategory === qLower) {
        score += 300;
      } else if (category.includes(qLower) || subcategory.includes(qLower)) {
        score += 150;
      }

      // SKU matches
      if (sku === qLower) {
        score += 100;
      } else if (sku.includes(qLower)) {
        score += 50;
      }

      // Brand matches
      if (brand === qLower) {
        score += 80;
      } else if (brand.includes(qLower)) {
        score += 30;
      }

      return score;
    };

    rawProducts.sort((a, b) => getRelevanceScore(b, query) - getRelevanceScore(a, query));

    const queryLower = query.toLowerCase();
    const suggestionsSet = new Set();

    rawProducts.forEach(p => {
      if (p.category && p.category.toLowerCase().includes(queryLower)) {
        suggestionsSet.add(p.category.trim());
      }
      if (p.brand && p.brand.toLowerCase().includes(queryLower)) {
        suggestionsSet.add(p.brand.trim());
      }
      if (p.subcategory && p.subcategory.toLowerCase().includes(queryLower)) {
        suggestionsSet.add(p.subcategory.trim());
      }
      if (p.sku && p.sku.toLowerCase().includes(queryLower)) {
        suggestionsSet.add(p.sku.trim().toUpperCase());
      }
      if (p.keywords) {
        const kwList = p.keywords.split(',').map(k => k.trim());
        kwList.forEach(kw => {
          if (kw.toLowerCase().includes(queryLower)) {
            suggestionsSet.add(kw);
          }
        });
      }
      if (p.name && p.name.toLowerCase().includes(queryLower)) {
        suggestionsSet.add(p.name.trim());
      }
    });

    const suggestions = Array.from(suggestionsSet)
      .filter(item => item.length >= query.length)
      .slice(0, 6);

    const products = rawProducts.slice(0, 4).map(p => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      brand: p.brand,
      category: p.category,
      image: p.image,
      price: p.price
    }));

    res.json({ suggestions, products });
  } catch (error) {
    console.error("Autocomplete failed:", error);
    sendErrorResponse(res, error, "Search suggestions failed");
  }
});

// GET product metadata for sidebar filters
app.get("/api/products/metadata", async (req, res) => {
  try {
    const brands = await Product.distinct("brand", { isActive: true });
    const subcats = await Product.distinct("subcategory", { isActive: true });
    const categories = await Product.distinct("category", { isActive: true });
    res.json({
      brands: brands.filter(Boolean),
      categories: categories.filter(Boolean),
      subcategories: subcats.filter(Boolean)
    });
  } catch (error) {
    console.error("Metadata fetch failed:", error);
    sendErrorResponse(res, error, "Failed to fetch metadata");
  }
});

// GET paginated products
app.get("/api/products/paginated", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 24;
    const search = req.query.search || '';
    const category = req.query.category || '';
    const subcategory = req.query.subcategory || '';
    const brand = req.query.brand || '';
    const sort = req.query.sort || 'default';

    const query = { isActive: { $ne: false } };

    if (category && category !== 'All') query.category = category;
    if (subcategory && subcategory !== 'All') query.subcategory = subcategory;
    if (brand && brand !== 'All') query.brand = brand;
    if (search) {
      const regex = new RegExp(search, "i");
      query.$or = [
        { name: regex },
        { sku: regex },
        { keywords: regex },
        { description: regex }
      ];
    }

    let sortOption = { id: 1 };
    if (sort === 'newest') sortOption = { createdAt: -1, id: -1 };
    else if (sort === 'price-low') sortOption = { price: 1, id: 1 };
    else if (sort === 'price-high') sortOption = { price: -1, id: 1 };
    else if (sort === 'name-asc') sortOption = { name: 1, id: 1 };
    else if (sort === 'name-desc') sortOption = { name: -1, id: 1 };

    const totalCount = await Product.countDocuments(query);
    const products = await Product.find(query)
      .select("-description -images -specifications -features -catalogue -dimensions -weightKg")
      .lean()
      .sort(sortOption)
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      products,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit)
    });
  } catch (error) {
    console.error("Failed to fetch paginated products:", error);
    sendErrorResponse(res, error, "Failed to fetch paginated products");
  }
});

// GET all products (MongoDB)
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find({})
      .select("-description -images -specifications -features -catalogue -dimensions -weightKg")
      .lean()
      .sort({ id: 1 })
      .maxTimeMS(10000);
    res.json(products);
  } catch (error) {
    console.error("Failed to read products:", error);
    sendErrorResponse(res, error, "Failed to read products");
  }
});

// GET single product (MongoDB)
app.get("/api/products/:id", async (req, res) => {
  try {
    const param = req.params.id;
    const isId = !isNaN(param);

    let product;
    if (isId) {
      product = await Product.findOne({ id: Number(param) });
      if (!product) {
        // Fall back to looking by slug (e.g. for products whose slug is a number like '32218')
        product = await Product.findOne({ slug: param });
      }
    } else {
      product = await Product.findOne({ slug: param });
    }

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(product);
  } catch (error) {
    console.error("Failed to read product:", error);
    sendErrorResponse(res, error, "Failed to read product");
  }
});

// CREATE product - admin only (MongoDB + Cloudinary)
app.post("/api/products", auth, adminOnly, async (req, res) => {
  try {
    const body = { ...req.body };

    // Convert images array from plain URL strings to {url, publicId} objects
    if (Array.isArray(body.images)) {
      body.images = body.images.map((img) =>
        typeof img === "string" ? { url: img, publicId: "" } : img
      );
    }

    // If an explicit id is provided, use it; otherwise auto-generated by model
    if (body.id) {
      body.id = Number(body.id);
    }

    const product = new Product(body);
    await product.save();

    res.status(201).json(product);
  } catch (error) {
    console.error("Failed to create product:", error);
    sendErrorResponse(res, error, "Failed to create product");
  }
});

// UPDATE product - admin only (MongoDB + Cloudinary)
app.put("/api/products/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = { ...req.body };

    if (Array.isArray(body.images)) {
      body.images = body.images.map((img) =>
        typeof img === "string" ? { url: img, publicId: "" } : img
      );
    }

    if (body.id) body.id = Number(body.id);

    const product = await Product.findOneAndUpdate(
      { id },
      { $set: body },
      { new: true, runValidators: true }
    );

    if (!product) return res.status(404).json({ message: "Product not found" });

    res.json(product);
  } catch (error) {
    console.error("Failed to update product:", error);
    sendErrorResponse(res, error, "Failed to update product");
  }
});

// --- SECURE RAZORPAY PAYMENT FLOW ---

// --- GST-BASED COUPON SYSTEM ---
const GST_COUPON_RULES = {
  'MEFIRST': { milestone: 1, minOrder: 10000, discount: 500, label: "Business Welcome" },
  'MESECOND': { milestone: 2, minOrder: 20000, discount: 1000, label: "Business Loyalty" },
  'METHIRD': { milestone: 3, minOrder: 50000, discount: 2500, label: "Business Premium" }
};

const validateGSTFormat = (gst) => {
  const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  return gstRegex.test(gst);
};

app.post("/api/coupons/validate-gst", auth, async (req, res) => {
  try {
    const { code, subtotal, gstNumber } = req.body;

    if (!gstNumber) return res.status(400).json({ message: "A valid GST number is required for this coupon" });
    if (!validateGSTFormat(gstNumber.toUpperCase())) {
      return res.status(400).json({ message: "Invalid GST format" });
    }

    const rule = GST_COUPON_RULES[code.toUpperCase()];
    if (!rule) return res.status(404).json({ message: "Invalid GST coupon code" });

    // Check usage history by GST Number across ALL users/orders
    const gstUsageCount = await Order.countDocuments({
      "shippingAddress.gstNumber": gstNumber.toUpperCase(),
      status: { $nin: ["CANCELLED", "PENDING"] }
    });

    if (rule.milestone === 1 && gstUsageCount > 0) {
      return res.status(400).json({ message: "This GST has already used the first purchase coupon." });
    }
    if (rule.milestone === 2 && gstUsageCount === 0) {
      return res.status(400).json({ message: "This coupon is only valid for your second or later purchase." });
    }
    if (rule.milestone > 2) {
      if (gstUsageCount + 1 !== rule.milestone) {
        if (gstUsageCount + 1 < rule.milestone) {
          return res.status(400).json({ message: `This is for GST purchase #${rule.milestone}. This GST has ${gstUsageCount} past purchases.` });
        } else {
          return res.status(400).json({ message: "This GST has already used or passed this milestone coupon." });
        }
      }
    }

    if (subtotal < rule.minOrder) {
      return res.status(400).json({ message: `Minimum order value for this coupon is ₹${rule.minOrder.toLocaleString()}` });
    }

    res.json({
      success: true,
      code: code.toUpperCase(),
      discount: rule.discount,
      label: rule.label,
      usageCount: gstUsageCount + 1
    });
  } catch (error) {
    console.error("GST Coupon Error:", error);
    sendErrorResponse(res, error, "Coupon validation failed");
  }
});

// GET eligible GST coupon
app.get("/api/coupons/eligible-gst", async (req, res) => {
  try {
    const { gstNumber } = req.query;
    if (!gstNumber || !validateGSTFormat(gstNumber.toUpperCase())) {
      return res.json({ eligible: false, code: null });
    }

    const gstUsageCount = await Order.countDocuments({
      "shippingAddress.gstNumber": gstNumber.toUpperCase(),
      status: { $nin: ["CANCELLED", "PENDING"] }
    });

    if (gstUsageCount === 0) {
      return res.json({ eligible: true, code: "MEFIRST" });
    } else {
      return res.json({ eligible: true, code: "MESECOND" });
    }
  } catch (error) {
    console.error("GST Eligibility Error:", error);
    sendErrorResponse(res, error, "Failed to check GST eligibility");
  }
});

// 1. Create Razorpay or COD Order
app.post("/api/payment/create-order", auth, async (req, res) => {
  try {
    const { items, shippingAddress, couponCode, paymentMethod = "PREPAID", courierId = null, deliveryMethod = "STANDARD", porterDeliveryDetails = null } = req.body;
    const userId = req.user.uid || req.user.username;

    if (!items || !items.length) return res.status(400).json({ message: "Cart is empty" });

    let { finalTotal, itemsWithDetails, subtotal, discountAmount, gstAmount, shippingCharge, shippingDetails } = await calculateOrderTotal(items, userId, shippingAddress, courierId, paymentMethod, deliveryMethod);

    // Apply GST Coupon if provided
    let appliedCoupon = null;
    let usageCount = 0;
    const gst = shippingAddress?.gstNumber?.toUpperCase();

    if (couponCode && gst) {
      const rule = GST_COUPON_RULES[couponCode.toUpperCase()];
      if (rule && validateGSTFormat(gst)) {
        usageCount = await Order.countDocuments({
          "shippingAddress.gstNumber": gst,
          status: { $nin: ["CANCELLED", "PENDING"] }
        });

        if (usageCount + 1 === rule.milestone && subtotal >= rule.minOrder) {
          appliedCoupon = couponCode.toUpperCase();
          discountAmount += rule.discount;
          finalTotal = Math.max(0, finalTotal - rule.discount);
        }
      }
    }

    let razorpayOrderId = null;
    let rzpAmount = 0;
    let rzpCurrency = "INR";

    if (paymentMethod === "PREPAID") {
      if (!razorpay) return res.status(500).json({ message: "Razorpay is not configured on the server" });
      const options = {
        amount: finalTotal * 100,
        currency: "INR",
        receipt: `rcpt_${Date.now()}`,
      };

      const razorpayOrder = await razorpay.orders.create(options);
      razorpayOrderId = razorpayOrder.id;
      rzpAmount = razorpayOrder.amount;
      rzpCurrency = razorpayOrder.currency;
    }

    const newOrder = new Order({
      orderId: `ORD_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      razorpayOrderId: razorpayOrderId,
      userId: userId,
      items: itemsWithDetails,
      subtotal,
      discountAmount,
      gstAmount,
      shippingCharge,
      shippingDetails,
      total: finalTotal,
      shippingAddress,
      paymentMethod: paymentMethod,
      deliveryMethod: deliveryMethod,
      porterDeliveryDetails: porterDeliveryDetails,
      status: paymentMethod === "COD" ? "PLACED" : "PENDING",
      paymentDetails: {
        status: paymentMethod === "COD" ? "SUCCESS" : "PENDING",
        transactionId: paymentMethod === "COD" ? `COD_${Date.now()}` : undefined
      },
      couponCode: appliedCoupon,
      purchaseCount: appliedCoupon ? usageCount + 1 : undefined, // Usage count for this GST
      createdAt: new Date().toISOString(),
    });

    await newOrder.save();


    // --- Persistence: Save Address to User Profile ---
    try {
      const user = await User.findOne({
        $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }]
      });

      if (user && shippingAddress) {
        // Check if address already exists (simple string match for street/city/zip)
        const exists = user.addresses.some(addr =>
          addr.street === shippingAddress.street &&
          addr.city === shippingAddress.city &&
          addr.zip === shippingAddress.zip
        );

        if (!exists) {
          user.addresses.push({
            ...shippingAddress,
            id: `addr_${Date.now()}`
          });
          // If first address, make it default
          if (user.addresses.length === 1) {
            user.addresses[0].isDefault = true;
          }
          await user.save();
        }
      }
    } catch (saveAddrErr) {
      console.error("Failed to auto-save address to user profile:", saveAddrErr);
    }

    res.json({
      id: razorpayOrderId,
      amount: rzpAmount || finalTotal * 100,
      currency: rzpCurrency,
      localOrderId: newOrder.orderId,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      paymentMethod,
      order: newOrder
    });

    logAudit("ORDER_CREATED", userId, { orderId: newOrder.orderId, total: finalTotal });

    if (paymentMethod === "COD") {
      const customerPhone = newOrder.shippingAddress?.phone || newOrder.userId;
      if (customerPhone) {
        console.log(`Triggering COD order placement alerts for order ${newOrder.orderId} to ${customerPhone}`);
        sendSMSOrderAlert(customerPhone, newOrder.orderId, "confirmed")
          .catch(err => console.error("Auto SMS Alert Error:", err));
        sendWhatsAppOrderAlert(customerPhone, newOrder.orderId, "confirmed")
          .catch(err => console.error("Auto WhatsApp Alert Error:", err));
      }
      sendAdminNewOrderAlert(newOrder)
        .catch(err => console.error("Admin SMS Alert Error:", err));
    }
  } catch (error) {
    console.error("Create Order Error:", error);
    res.status(500).json({
      message: "Order creation failed",
      error: error.message,
      details: error.description || error.metadata || null
    });
  }
});

// 2. Verify Payment Signature (Fallback for frontend)
app.post("/api/payment/verify", auth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  try {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      let order = await Order.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id, status: { $ne: "PAID" } },
        {
          status: "PAID",
          razorpayPaymentId: razorpay_payment_id,
          paidAt: new Date().toISOString(),
          "paymentDetails.status": "SUCCESS",
          "paymentDetails.transactionId": razorpay_payment_id,
          "paymentDetails.updatedAt": new Date()
        },
        { new: true }
      );

      let isNewPaid = !!order;
      if (!order) {
        // Already marked as PAID by webhook
        order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
      }

      if (order) {
        logAudit("PAYMENT_VERIFIED_CLIENT", req.user.uid || req.user.username, { orderId: order.orderId });

        if (isNewPaid) {
          const customerPhone = order.shippingAddress?.phone || order.userId;
          if (customerPhone) {
            console.log(`Triggering payment success alerts for order ${order.orderId} to ${customerPhone}`);
            sendSMSOrderAlert(customerPhone, order.orderId, "confirmed")
              .catch(err => console.error("Auto SMS Alert Error:", err));
            sendWhatsAppOrderAlert(customerPhone, order.orderId, "confirmed")
              .catch(err => console.error("Auto WhatsApp Alert Error:", err));
          }
          sendAdminNewOrderAlert(order)
            .catch(err => console.error("Admin SMS Alert Error:", err));
        }
      }

      res.json({ success: true, message: "Payment verified successfully", order });
    } else {
      logAudit("PAYMENT_VERIFICATION_FAILED", req.user.uid || req.user.username, { razorpayOrderId: razorpay_order_id });
      res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (error) {
    sendErrorResponse(res, error, "Verification failed");
  }
});

// 2b. Record Payment Failure
app.post("/api/payment/record-failure", auth, async (req, res) => {
  const { razorpay_order_id, error_message, gateway_response } = req.body;
  try {
    const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
    if (order) {
      order.paymentDetails = {
        status: "FAILED",
        errorMessage: error_message,
        gatewayResponse: gateway_response,
        updatedAt: new Date()
      };
      await order.save();
    }
    res.json({ success: true });
  } catch (error) {
    sendErrorResponse(res, error, "An internal server error occurred");
  }
});

// 3. Webhook for Async Payment Confirmation
// Razorpay calls this for events like order.paid
app.post("/api/payment/webhook", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  if (!secret || !signature) {
    return res.status(400).json({ message: "Missing webhook secret or signature" });
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  if (expectedSignature !== signature) {
    logAudit("WEBHOOK_SIGNATURE_MISMATCH", "SYSTEM", { signature });
    return res.status(400).json({ message: "Invalid webhook signature" });
  }

  const event = req.body.event;
  const payload = req.body.payload.payment.entity;

  if (event === "payment.captured") {
    const orderId = payload.order_id;
    const paymentId = payload.id;

    try {
      const order = await Order.findOneAndUpdate(
        { razorpayOrderId: orderId, status: { $ne: "PAID" } },
        {
          status: "PAID",
          razorpayPaymentId: paymentId,
          paidAt: new Date().toISOString(),
          "paymentDetails.status": "SUCCESS",
          "paymentDetails.transactionId": paymentId,
          "paymentDetails.updatedAt": new Date()
        },
        { new: true }
      );

      if (order) {
        logAudit("PAYMENT_CAPTURED_WEBHOOK", "RAZORPAY", { orderId: order.orderId, paymentId });
        console.log(`✅ Webhook: Order ${order.orderId} marked as PAID`);

        const customerPhone = order.shippingAddress?.phone || order.userId;
        if (customerPhone) {
          console.log(`Triggering payment success alerts (webhook) for order ${order.orderId} to ${customerPhone}`);
          sendSMSOrderAlert(customerPhone, order.orderId, "confirmed")
            .catch(err => console.error("Auto SMS Alert Error:", err));
          sendWhatsAppOrderAlert(customerPhone, order.orderId, "confirmed")
            .catch(err => console.error("Auto WhatsApp Alert Error:", err));
        }
        sendAdminNewOrderAlert(order)
          .catch(err => console.error("Admin SMS Alert Error:", err));
      }
    } catch (err) {
      console.error("Webhook Order Update Error:", err);
    }
  }

  res.json({ status: "ok" });
});

// GET user orders
app.get("/api/orders/:username", auth, async (req, res) => {
  const { username } = req.params;
  const requesterId = req.user.uid || req.user.username;

  try {
    // Find requester's user doc to get all their valid identifiers
    const requesterDoc = await User.findOne({
      $or: [
        { id: requesterId },
        { username: requesterId },
        { email: req.user.email || requesterId },
        { phone: requesterId },
        { firebaseUid: req.user.uid || requesterId }
      ]
    }).lean();

    const requesterIdentifiers = new Set();
    if (requesterId) requesterIdentifiers.add(requesterId);
    if (req.user.email) requesterIdentifiers.add(req.user.email.toLowerCase());
    if (req.user.uid) requesterIdentifiers.add(req.user.uid);
    if (requesterDoc) {
      if (requesterDoc.id) requesterIdentifiers.add(requesterDoc.id);
      if (requesterDoc.username) requesterIdentifiers.add(requesterDoc.username.toLowerCase());
      if (requesterDoc.email) requesterIdentifiers.add(requesterDoc.email.toLowerCase());
      if (requesterDoc.phone) {
        requesterIdentifiers.add(requesterDoc.phone);
        requesterIdentifiers.add(requesterDoc.phone.replace("+91", "").trim());
      }
      if (requesterDoc.firebaseUid) requesterIdentifiers.add(requesterDoc.firebaseUid);
    }

    // Check if target username matches any of the requester's identifiers or they are admin/employee
    const cleanUsername = username ? username.toLowerCase() : "";

    const isAuthorized = requesterIdentifiers.has(cleanUsername) ||
      (username && requesterIdentifiers.has(username)) ||
      req.user.role === 'admin' ||
      req.user.role === 'employee';

    if (!isAuthorized) {
      logAudit("UNAUTHORIZED_ORDER_FETCH_ATTEMPT", requesterId, { targetUser: username });
      return res.status(403).json({ message: "Forbidden: You can only view your own orders" });
    }

    // Build query IDs (strictly filter out undefined, null, empty string)
    const rawQueryIds = Array.from(requesterIdentifiers);
    if (username) {
      rawQueryIds.push(username);
      if (username.startsWith("+91")) {
        rawQueryIds.push(username.replace("+91", ""));
      } else if (/^\d{10}$/.test(username)) {
        rawQueryIds.push("+91" + username);
      }
    }
    const queryIds = rawQueryIds.filter(id => id !== undefined && id !== null && id !== "");

    // Perform a case-insensitive search for email addresses if needed, but matching in queryIds works
    const orders = await Order.find({
      $or: [
        { userId: { $in: queryIds } },
        { "shippingAddress.phone": { $in: queryIds } },
        { "shippingAddress.email": { $in: queryIds.map(id => new RegExp(`^${id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i')) } }
      ],
      status: { $nin: ["PENDING", "CANCELLED", "Cancelled", "FAILED", "failed", "pending", "cancelled"] }, // Only show successful payment products
      hiddenFromUser: { $ne: true } // Don't show hidden orders
    }).sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    console.error("Failed to fetch orders:", error);
    sendErrorResponse(res, error, "Failed to fetch orders");
  }
});

// HIDE order from user history
app.patch("/api/orders/:orderId/hide", auth, async (req, res) => {
  const { orderId } = req.params;
  const userId = req.user.uid || req.user.username;

  try {
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Find requester's user doc to get all their valid identifiers
    const requesterDoc = await User.findOne({
      $or: [
        { id: userId },
        { username: userId },
        { email: req.user.email || userId },
        { phone: userId },
        { firebaseUid: req.user.uid || userId }
      ]
    }).lean();

    const requesterIdentifiers = new Set();
    if (userId) requesterIdentifiers.add(userId);
    if (req.user.email) requesterIdentifiers.add(req.user.email.toLowerCase());
    if (req.user.uid) requesterIdentifiers.add(req.user.uid);
    if (requesterDoc) {
      if (requesterDoc.id) requesterIdentifiers.add(requesterDoc.id);
      if (requesterDoc.username) requesterIdentifiers.add(requesterDoc.username.toLowerCase());
      if (requesterDoc.email) requesterIdentifiers.add(requesterDoc.email.toLowerCase());
      if (requesterDoc.phone) {
        requesterIdentifiers.add(requesterDoc.phone);
        requesterIdentifiers.add(requesterDoc.phone.replace("+91", "").trim());
      }
      if (requesterDoc.firebaseUid) requesterIdentifiers.add(requesterDoc.firebaseUid);
    }

    const orderUserIds = [
      order.userId,
      order.shippingAddress?.email ? order.shippingAddress.email.toLowerCase() : null,
      order.shippingAddress?.phone,
      order.shippingAddress?.phone ? order.shippingAddress.phone.replace("+91", "").trim() : null
    ].filter(Boolean);

    // SECURITY: Ensure only the owner (by UID, username, or shipping contact) or Admin can hide it
    const isOwner = orderUserIds.some(id => requesterIdentifiers.has(id)) ||
      (order.userId && requesterIdentifiers.has(order.userId)) ||
      (order.shippingAddress?.email && requesterIdentifiers.has(order.shippingAddress.email.toLowerCase())) ||
      (order.shippingAddress?.phone && requesterIdentifiers.has(order.shippingAddress.phone));

    if (!isOwner && req.user.role !== 'admin' && req.user.role !== 'employee') {
      logAudit("UNAUTHORIZED_ORDER_HIDE_ATTEMPT", userId, { orderId });
      return res.status(403).json({ message: "Forbidden" });
    }

    order.hiddenFromUser = true;
    await order.save();

    logAudit("ORDER_HIDDEN", userId, { orderId });
    res.json({ success: true, message: "Order removed from history" });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to hide order");
  }
});

// GET all orders (for Employee/Admin Panel)
app.get("/api/admin/orders", auth, employeeOrAdmin, async (req, res) => {
  try {
    const orders = await Order.find({}).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch all orders");
  }
});

// UPDATE order status (Employee/Admin)
app.patch("/api/admin/orders/:orderId/status", auth, employeeOrAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, trackingId, trackingLink, porterStatus, bookManually } = req.body;

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (trackingId !== undefined) updateData.trackingId = trackingId;
    if (trackingLink !== undefined) updateData.trackingLink = trackingLink;
    if (porterStatus !== undefined) updateData["porterDeliveryDetails.porterStatus"] = porterStatus;
    if (bookManually !== undefined) updateData["porterDeliveryDetails.bookManually"] = bookManually;

    const order = await Order.findOneAndUpdate(
      { orderId },
      { $set: updateData },
      { new: true }
    );

    if (!order) return res.status(404).json({ message: "Order not found" });

    // Automatically send SMS and WhatsApp alert if phone number is available
    const customerPhone = order.shippingAddress?.phone || order.userId;
    if (customerPhone) {
      console.log(`Triggering status update alerts for order ${orderId} to ${customerPhone}`);
      sendSMSOrderAlert(customerPhone, orderId, status)
        .catch(err => console.error("Auto SMS Alert Error:", err));
      sendWhatsAppOrderAlert(customerPhone, orderId, status)
        .catch(err => console.error("Auto WhatsApp Alert Error:", err));
    } else {
      console.log(`No phone number found for order ${orderId}, skipping alerts.`);
    }

    res.json({ success: true, message: "Status updated", order });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update order status");
  }
});

// Employee Management (Admin Only)
app.get("/api/admin/employees", auth, adminOnly, async (req, res) => {
  try {
    const employees = await Employee.find({});
    res.json(employees);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch employees");
  }
});

app.post("/api/admin/employees", auth, adminOnly, async (req, res) => {
  try {
    let userEmail = req.user.email;
    if (!userEmail && req.user.username) {
      const emp = await Employee.findOne({ username: req.user.username });
      if (emp) userEmail = emp.email;
    }

    if (userEmail !== 'dipanshu@pvtchopra.com') {
      return res.status(403).json({ message: "Only the super admin (dipanshu@pvtchopra.com) is authorized to add new employees." });
    }

    const newEmployee = new Employee({
      id: Date.now().toString(),
      ...req.body,
      permissions: req.body.permissions || ["view_orders", "edit_status"]
    });
    await newEmployee.save();
    res.json(newEmployee);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to create employee");
  }
});

app.put("/api/admin/employees/:id", auth, adminOnly, async (req, res) => {
  try {
    let userEmail = req.user.email;
    if (!userEmail && req.user.username) {
      const emp = await Employee.findOne({ username: req.user.username });
      if (emp) userEmail = emp.email;
    }

    if (userEmail !== 'dipanshu@pvtchopra.com') {
      return res.status(403).json({ message: "Only the super admin (dipanshu@pvtchopra.com) is authorized to modify employees." });
    }

    const employee = await Employee.findOneAndUpdate(
      { id: req.params.id },
      { $set: req.body },
      { new: true }
    );
    if (!employee) return res.status(404).json({ message: "Employee not found" });
    res.json(employee);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update employee");
  }
});

app.delete("/api/admin/employees/:id", auth, adminOnly, async (req, res) => {
  try {
    let userEmail = req.user.email;
    if (!userEmail && req.user.username) {
      const emp = await Employee.findOne({ username: req.user.username });
      if (emp) userEmail = emp.email;
    }

    if (userEmail !== 'dipanshu@pvtchopra.com') {
      return res.status(403).json({ message: "Only the super admin (dipanshu@pvtchopra.com) is authorized to delete employees." });
    }

    await Employee.deleteOne({ id: req.params.id });
    res.json({ message: "Employee deleted" });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to delete employee");
  }
});

// User Management (Admin Only)
app.get("/api/admin/users", auth, adminOrManager, async (req, res) => {
  try {
    const users = await User.find({});
    res.json(users);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch users");
  }
});

app.patch("/api/admin/users/:id/discount", auth, adminOrManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { specialDiscount } = req.body;

    const user = await User.findOneAndUpdate(
      { id },
      { specialDiscount: Number(specialDiscount) || 0 },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json(user);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update user discount");
  }
});

app.patch("/api/admin/users/:id/gst", auth, adminOrManager, async (req, res) => {
  try {
    const { id } = req.params;
    const { gstNumber } = req.body;

    const user = await User.findOneAndUpdate(
      { id },
      { gstNumber: gstNumber || "" },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json(user);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update user GST");
  }
});

// --- Promotional Campaigns API Endpoints ---

// GET: Fetch history of promotional broadcasts
app.get("/api/admin/promotions", auth, adminOrManager, async (req, res) => {
  try {
    const promotions = await Promotion.find({}).sort({ sentAt: -1 });
    res.json(promotions);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch promotions history");
  }
});

// POST: Broadcast promotional messages to selected users via SMS and/or WhatsApp
app.post("/api/admin/promotions", auth, adminOrManager, async (req, res) => {
  try {
    const { message, channels, userIds } = req.body;
    if (!message || !channels || !userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "Invalid request payload. Message, channels, and recipient userIds are required." });
    }

    const users = await User.find({ id: { $in: userIds } });
    if (users.length === 0) {
      return res.status(404).json({ message: "No valid users found for specified recipient IDs." });
    }

    const sender = req.user.name || req.user.email || req.user.username || "Admin";
    const campaignId = "promo_" + Date.now() + "_" + Math.floor(Math.random() * 1000);

    const recipientResults = [];

    for (const user of users) {
      if (!user.phone) {
        recipientResults.push({
          userId: user.id,
          name: user.name || "Unknown",
          phone: "N/A",
          status: "failed",
          error: "No phone number configured"
        });
        continue;
      }

      // Perform placeholder replacement
      let personalizedMsg = message
        .replace(/{{name}}/gi, user.name || "Customer")
        .replace(/{{company}}/gi, user.company || "your business");

      let smsSuccess = true;
      let waSuccess = true;
      let errors = [];

      if (channels.includes("sms")) {
        try {
          await sendPromotionalSMS(user.phone, personalizedMsg);
        } catch (err) {
          smsSuccess = false;
          errors.push(`SMS: ${err.message}`);
        }
      }

      if (channels.includes("whatsapp")) {
        try {
          await sendPromotionalWhatsApp(user.phone, personalizedMsg);
        } catch (err) {
          waSuccess = false;
          errors.push(`WhatsApp: ${err.message}`);
        }
      }

      const overallSuccess = (!channels.includes("sms") || smsSuccess) && (!channels.includes("whatsapp") || waSuccess);

      recipientResults.push({
        userId: user.id,
        name: user.name || "Customer",
        phone: user.phone,
        status: overallSuccess ? "success" : "failed",
        error: errors.length > 0 ? errors.join("; ") : undefined
      });
    }

    const promotionRecord = new Promotion({
      id: campaignId,
      message,
      channels,
      sentBy: sender,
      recipients: recipientResults
    });

    await promotionRecord.save();

    res.json({
      success: true,
      message: "Promotional campaign sent and logged successfully.",
      campaign: promotionRecord
    });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to broadcast promotional campaign");
  }
});

app.delete("/api/products/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const product = await Product.findOne({ id });

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Clean up Cloudinary assets
    try {
      if (product.imagePublicId) {
        await deleteFromCloudinary(product.imagePublicId);
      }
      if (product.cataloguePublicId) {
        await deleteFromCloudinary(product.cataloguePublicId, "raw");
      }
      if (product.images && product.images.length) {
        for (const img of product.images) {
          if (img.publicId) {
            await deleteFromCloudinary(img.publicId);
          }
        }
      }
    } catch (cloudinaryErr) {
      console.error(`Failed to delete Cloudinary assets for product ${id}:`, cloudinaryErr);
    }

    await Product.deleteOne({ id });
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Failed to delete product:", error);
    sendErrorResponse(res, error, "Failed to delete product");
  }
});

app.post("/api/products/bulk-delete", auth, adminOnly, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "No product IDs provided" });
    }

    // Convert IDs to numbers to ensure they match the schema type in queries
    const numericIds = ids.map(id => Number(id)).filter(id => !isNaN(id));

    const products = await Product.find({ id: { $in: numericIds } });

    for (const product of products) {
      // Clean up Cloudinary assets
      try {
        if (product.imagePublicId) {
          await deleteFromCloudinary(product.imagePublicId);
        }
        if (product.cataloguePublicId) {
          await deleteFromCloudinary(product.cataloguePublicId, "raw");
        }
        if (product.images && product.images.length) {
          for (const img of product.images) {
            if (img.publicId) {
              await deleteFromCloudinary(img.publicId);
            }
          }
        }
      } catch (cloudinaryErr) {
        console.error(`Failed to delete Cloudinary assets for bulk product ${product.id}:`, cloudinaryErr);
      }
    }

    const result = await Product.deleteMany({ id: { $in: numericIds } });
    res.json({ message: `${result.deletedCount} products deleted successfully` });
  } catch (error) {
    console.error("Failed to bulk delete products:", error);
    sendErrorResponse(res, error, "Failed to bulk delete products");
  }
});

// Update User Profile (Self)
app.post("/api/user/update-profile", auth, async (req, res) => {
  try {
    const { name, email, company, gstNumber, profilePic } = req.body;

    const user = await User.findOneAndUpdate(
      { $or: [{ firebaseUid: req.user.uid || req.user.username }, { phone: req.user.username }, { username: req.user.username }] },
      {
        $set: {
          name,
          email,
          company,
          gstNumber,
          profilePic
        }
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      success: true,
      message: "Profile updated successfully",
      user
    });
  } catch (error) {
    console.error("Profile Update Error:", error);
    sendErrorResponse(res, error, "Failed to update profile");
  }
});

// Quote Request Endpoint
app.post("/api/request-quote", auth, async (req, res) => {
  try {
    const { name, company, email, phone, items, message, product, quantity } = req.body;
    const quoteId = `QT_${Date.now()}`;
    const username = req.user.uid || req.user.username;

    // Calculate total original amount if items are present
    let totalOriginalAmount = 0;
    let formattedItems = [];

    if (items && Array.isArray(items)) {
      formattedItems = items.map(item => {
        const origPrice = Number(item.price) || 0;
        const qty = Number(item.quantity) || 1;
        totalOriginalAmount += origPrice * qty;
        return {
          productId: item.id || item.productId,
          name: item.name,
          image: item.image,
          quantity: qty,
          originalPrice: origPrice,
          offeredPrice: origPrice, // Initial offer matches original
          counterPrice: 0
        };
      });
    }

    const quoteData = new Quote({
      id: quoteId,
      name,
      company,
      email,
      phone,
      product: product || (formattedItems.length > 0 ? formattedItems[0].name : ""),
      quantity: quantity || (formattedItems.length > 0 ? String(formattedItems[0].quantity) : "1"),
      message,
      userId: username,
      items: formattedItems,
      totalOriginalAmount,
      totalOfferedAmount: totalOriginalAmount,
      status: "Pending Review",
      negotiationHistory: [{
        sender: "customer",
        senderName: name || username,
        message: message || "Requested a B2B volume price quote.",
        createdAt: new Date()
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date()
    });

    await quoteData.save();

    // Forward to Google Sheets if configured
    const googleSheetUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL;
    if (googleSheetUrl && googleSheetUrl !== "https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec") {
      try {
        const dataString = JSON.stringify(quoteData);
        fetch(googleSheetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: dataString
        })
          .then(async (response) => {
            if (!response.ok) {
              console.error(`Google Sheet Webhook Error: Status ${response.status}`);
            }
          })
          .catch((e) => console.error("Google Sheet Forwarding Error:", e));
      } catch (gsError) {
        console.error("Failed to forward to Google Sheets:", gsError);
      }
    }

    res.status(201).json({ success: true, message: "Quote request received", quoteId });
  } catch (error) {
    console.error("Quote Request Error:", error);
    sendErrorResponse(res, error, "Failed to process quote request");
  }
});

// GET My Quotes
app.get("/api/quotes/my-quotes", auth, async (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    const quotes = await Quote.find({ userId: username }).sort({ createdAt: -1 });
    res.json(quotes);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch quotes");
  }
});

// GET Single Quote Detail
app.get("/api/quotes/:id", auth, async (req, res) => {
  try {
    const quote = await Quote.findOne({ id: req.params.id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });

    // Security check: Only the owner or employee/admin can view
    const isOwner = quote.userId === (req.user.uid || req.user.username);

    let userRole = req.user.role;
    if (req.user.firebase) {
      try {
        const query = { $or: [{ firebaseUid: req.user.uid }] };
        if (req.user.email) query.$or.push({ email: req.user.email });
        const employee = await Employee.findOne(query);
        if (employee) {
          userRole = employee.role;
          if (!employee.firebaseUid) {
            await Employee.updateOne({ id: employee.id }, { firebaseUid: req.user.uid });
          }
        }
      } catch (err) { }
    }
    const isStaff = ["admin", "employee", "staff", "manager"].includes(userRole?.toLowerCase());

    if (!isOwner && !isStaff) {
      return res.status(403).json({ message: "Forbidden: Access denied" });
    }

    res.json(quote);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch quote details");
  }
});

// POST Customer Negotiation (Accept, Reject, Counter Offer)
app.post("/api/quotes/:id/negotiate", auth, async (req, res) => {
  try {
    const { action, message, items } = req.body;
    const quote = await Quote.findOne({ id: req.params.id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });

    // Verify owner
    if (quote.userId !== (req.user.uid || req.user.username)) {
      return res.status(403).json({ message: "Forbidden: Only the quote owner can negotiate" });
    }

    if (action === "accept") {
      quote.status = "Accepted";
      quote.negotiationHistory.push({
        sender: "customer",
        senderName: req.user.name || req.user.email || req.user.username,
        message: message || "Accepted the pricing offer.",
        createdAt: new Date()
      });
    } else if (action === "reject") {
      quote.status = "Rejected";
      quote.negotiationHistory.push({
        sender: "customer",
        senderName: req.user.name || req.user.email || req.user.username,
        message: message || "Rejected the pricing offer.",
        createdAt: new Date()
      });
    } else if (action === "counter") {
      quote.status = "Counter Offered";

      // Update item counter prices
      if (items && Array.isArray(items)) {
        let totalCounterAmount = 0;
        quote.items = quote.items.map(dbItem => {
          const matchingItem = items.find(i => String(i.productId) === String(dbItem.productId));
          const counterPrice = matchingItem ? Number(matchingItem.counterPrice) : dbItem.offeredPrice;
          dbItem.counterPrice = counterPrice;
          totalCounterAmount += counterPrice * dbItem.quantity;
          return dbItem;
        });
        quote.totalCounterAmount = totalCounterAmount;
      }

      quote.negotiationHistory.push({
        sender: "customer",
        senderName: req.user.name || req.user.email || req.user.username,
        message: message || "Submitted counter-offer pricing.",
        createdAt: new Date()
      });
    } else {
      return res.status(400).json({ message: "Invalid action. Must be accept, reject, or counter" });
    }

    quote.updatedAt = new Date();
    await quote.save();

    res.json({ success: true, message: `Quote status updated to ${quote.status}`, quote });
  } catch (error) {
    console.error("Negotiation Error:", error);
    sendErrorResponse(res, error, "Failed to process negotiation response");
  }
});

// POST Convert Accepted Quote to Payable Order
app.post("/api/quotes/:id/convert-to-order", auth, async (req, res) => {
  try {
    const { shippingAddress } = req.body;
    const quote = await Quote.findOne({ id: req.params.id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });

    // Verify owner
    if (quote.userId !== (req.user.uid || req.user.username)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (quote.status !== "Accepted") {
      return res.status(400).json({ message: "Only accepted quotes can be converted to orders" });
    }

    const orderId = `ORD_${Date.now()}`;

    // Convert items into order format using the agreed offeredPrice
    let itemsPriceTotal = 0;
    const orderItems = quote.items.map(item => {
      const finalPrice = item.offeredPrice || item.originalPrice;
      itemsPriceTotal += finalPrice * item.quantity;
      return {
        id: item.productId,
        name: item.name,
        image: item.image,
        quantity: item.quantity,
        price: finalPrice
      };
    });

    const newOrder = new Order({
      orderId,
      userId: quote.userId,
      items: orderItems,
      shippingAddress: shippingAddress || {
        name: quote.name,
        phone: quote.phone,
        email: quote.email,
        address: "Address not provided, requested during quote",
        city: "",
        state: "",
        zip: ""
      },
      paymentMethod: "ONLINE",
      paymentDetails: {
        status: "PENDING",
        updatedAt: new Date()
      },
      status: "PENDING",
      subtotal: itemsPriceTotal,
      shippingCharge: 0,
      total: itemsPriceTotal,
      createdAt: new Date().toISOString()
    });

    await newOrder.save();

    quote.status = "Converted to Order";
    quote.orderId = orderId;
    quote.updatedAt = new Date();
    await quote.save();

    res.json({ success: true, message: "Quote successfully converted to order", orderId });
  } catch (error) {
    console.error("Convert Order Error:", error);
    sendErrorResponse(res, error, "Failed to convert quote to order");
  }
});

// POST Init B2B Payment for Quote Order
app.post("/api/quotes/:id/pay", auth, async (req, res) => {
  try {
    const quote = await Quote.findOne({ id: req.params.id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });

    // Verify owner
    if (quote.userId !== (req.user.uid || req.user.username)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!quote.orderId) {
      return res.status(400).json({ message: "Quote has not been converted to an order yet" });
    }

    const order = await Order.findOne({ orderId: quote.orderId });
    if (!order) return res.status(404).json({ message: "Linked order not found" });

    if (order.status === "PAID") {
      return res.status(400).json({ message: "Order is already paid" });
    }

    // Create Razorpay Order if not already present or if we need a new one
    if (!razorpay) return res.status(500).json({ message: "Razorpay is not configured" });

    let amountVal = order.total || order.subtotal || 0;
    if (amountVal <= 0 && order.items && order.items.length > 0) {
      amountVal = order.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    }

    if (amountVal <= 0) {
      return res.status(400).json({ message: "Order total amount must be greater than zero to initialize payment." });
    }

    const options = {
      amount: Math.round(amountVal * 100),
      currency: "INR",
      receipt: `rcpt_${quote.id}_${Date.now()}`
    };

    const razorpayOrder = await razorpay.orders.create(options);
    order.razorpayOrderId = razorpayOrder.id;
    await order.save();

    res.json({
      success: true,
      id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID,
      localOrderId: order.orderId
    });
  } catch (error) {
    console.error("B2B Payment Init Error:", error);
    sendErrorResponse(res, error, "Failed to initialize payment");
  }
});

// GET All Quotes (Staff/Admin)
app.get("/api/admin/quotes", auth, employeeOrAdmin, async (req, res) => {
  try {
    const quotes = await Quote.find({}).sort({ updatedAt: -1 });
    res.json(quotes);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch quotes");
  }
});

// POST Admin Offer Price
app.post("/api/admin/quotes/:id/offer", auth, employeeOrAdmin, async (req, res) => {
  try {
    const { items, message } = req.body;
    const quote = await Quote.findOne({ id: req.params.id });
    if (!quote) return res.status(404).json({ message: "Quote not found" });

    if (items && Array.isArray(items)) {
      let totalOfferedAmount = 0;
      quote.items = quote.items.map(dbItem => {
        const matchingItem = items.find(i => String(i.productId) === String(dbItem.productId));
        const offeredPrice = matchingItem ? Number(matchingItem.offeredPrice) : dbItem.originalPrice;
        dbItem.offeredPrice = offeredPrice;
        totalOfferedAmount += offeredPrice * dbItem.quantity;
        return dbItem;
      });
      quote.totalOfferedAmount = totalOfferedAmount;
    }

    quote.status = "Price Offered";
    quote.negotiationHistory.push({
      sender: "admin",
      senderName: req.user.name || req.user.username || "Manager/Staff",
      message: message || "Offered specialized B2B pricing details.",
      createdAt: new Date()
    });

    quote.updatedAt = new Date();
    await quote.save();

    res.json({ success: true, message: "Price offer submitted successfully", quote });
  } catch (error) {
    console.error("Admin Offer Error:", error);
    sendErrorResponse(res, error, "Failed to submit pricing offer");
  }
});

// --- Shipping Calculation Helpers ---
const determineZone = (state, city) => {
  const s = String(state).toLowerCase();
  const c = String(city).toLowerCase();

  // Shop is based in Ludhiana, Punjab
  if (c === "ludhiana") return "local";
  if (s === "punjab") return "state";

  const metroCities = ["mumbai", "delhi", "new delhi", "bangalore", "bengaluru", "kolkata", "chennai", "hyderabad", "ahmedabad", "pune"];
  if (metroCities.includes(c)) return "metro";

  return "national";
};

// --- Shipping Config Admin APIs ---
app.get("/api/admin/shipping-config", auth, authorize(['admin']), async (req, res) => {
  try {
    const config = await initializeDefaultConfig();
    res.json(config);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch shipping config");
  }
});

app.put("/api/admin/shipping-config", auth, authorize(['admin']), async (req, res) => {
  try {
    const config = await ShippingConfig.findOneAndUpdate({}, req.body, { new: true, upsert: true });
    logAudit("SHIPPING_CONFIG_UPDATED", req.user.username, { config: req.body });
    res.json(config);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update shipping config");
  }
});

app.get("/api/shipping/couriers", async (req, res) => {
  try {
    const config = await ShippingConfig.findOne() || await initializeDefaultConfig();
    const activeCouriers = config.couriers.filter(c => c.isActive).map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      baseRateAdjustment: c.baseRateAdjustment,
      rateMultiplier: c.rateMultiplier
    }));
    res.json(activeCouriers);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch active couriers");
  }
});

app.post("/api/calculate-shipping", async (req, res) => {
  try {
    const { items, city, state, method, invoiceValue, courierId, paymentMethod } = req.body;

    // Populate actual DB weights, dimensions and category
    const products = await Product.find({ id: { $in: items.map(i => i.id) } }).lean();
    const itemsForShipping = items.map(item => {
      const product = products.find(p => String(p.id) === String(item.id));
      return {
        ...item,
        weightKg: product?.weightKg,
        dimensions: product?.dimensions,
        category: product?.category
      };
    });

    const zoneKey = await detectZone(city, state);
    const result = await calculateCharges(itemsForShipping, zoneKey, method || "PER_KG", invoiceValue || 0, courierId, paymentMethod);
    res.json(result);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to calculate shipping charges");
  }
});

app.get("/", (req, res) => {
  res.send("Backend is live");
});

// System Health Check (for debugging)
app.get("/api/admin/health-check", auth, authorize(['admin']), async (req, res) => {
  const health = {
    database: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    razorpay: !!razorpay,
    razorpayConfigured: !!(process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.includes("xxxx")),
    envLoaded: !!process.env.MONGODB_URI
  };

  if (health.razorpay && health.razorpayConfigured) {
    try {
      await razorpay.orders.all({ count: 1 });
      health.razorpayStatus = "Valid Keys";
    } catch (e) {
      health.razorpayStatus = "Invalid Keys: " + e.message;
    }
  } else if (health.razorpay) {
    health.razorpayStatus = "Placeholder Keys Detected";
  } else {
    health.razorpayStatus = "Missing Keys";
  }

  res.json(health);
});
// --- Ticket Support System Endpoints ---

// Create Ticket
app.post("/api/tickets/create", auth, async (req, res) => {
  try {
    const ticketData = new Ticket({
      ticketId: "TKT-" + Date.now().toString().slice(-6),
      ...req.body,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await ticketData.save();
    res.status(201).json({ success: true, ticket: ticketData });
  } catch (error) {
    console.error("Ticket Create Error:", error);
    sendErrorResponse(res, error, "Failed to create ticket");
  }
});


// Connect to MongoDB, then start server


// Admin: Get All Tickets
app.get("/api/admin/tickets", auth, async (req, res) => {
  try {
    const tickets = await Ticket.find({}).sort({ createdAt: -1 });
    res.json(tickets);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch all tickets");
  }
});

// Get My Tickets
app.get("/api/tickets/my-tickets/:identifier", auth, async (req, res) => {
  try {
    const tickets = await Ticket.find({ userIdentifier: req.params.identifier });
    res.json(tickets);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch tickets");
  }
});

// Get Ticket Detail
app.get("/api/tickets/:id", auth, async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    res.json(ticket);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch ticket");
  }
});

// Add Reply to Ticket
app.post("/api/tickets/:id/reply", auth, async (req, res) => {
  try {
    const { message, fileUrl, senderRole, senderName } = req.body;
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    ticket.replies.push({
      sender: senderRole === 'admin' ? 'Admin' : 'Customer',
      senderName,
      message,
      fileUrl,
      createdAt: new Date()
    });

    ticket.status = senderRole === 'admin' ? 'Waiting for Customer' : 'In Progress';
    ticket.updatedAt = new Date();
    await ticket.save();

    res.json({ success: true, ticket });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to add reply");
  }
});

// Admin: Update Ticket Status/Priority
app.put("/api/tickets/:id/status", auth, adminOnly, async (req, res) => {
  try {
    const { status, priority, internalNotes } = req.body;
    const ticket = await Ticket.findOneAndUpdate(
      { ticketId: req.params.id },
      { $set: { status, priority, internalNotes, updatedAt: new Date() } },
      { new: true }
    );
    res.json({ success: true, ticket });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update ticket");
  }
});

// Admin: Claim/Assign Ticket
app.put("/api/admin/tickets/:id/assign", auth, async (req, res) => {
  try {
    const ticket = await Ticket.findOneAndUpdate(
      { ticketId: req.params.id },
      { $set: { assignedTo: req.user.username, status: "In Progress", updatedAt: new Date() } },
      { new: true }
    );
    res.json({ success: true, ticket });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to assign ticket");
  }
});


// Bulk Import Products (Admin Only)
const XLSX = require("xlsx");
// Helper to find a value in a row regardless of header case/spacing
const getVal = (row, keys) => {
  const rowKeys = Object.keys(row);
  for (const k of keys) {
    const foundKey = rowKeys.find(rk => rk.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (foundKey !== undefined) return row[foundKey];
  }
  return undefined;
};

// Process a single row from import Excel data
const importProductRow = async (row, rowIndex, existingProductsCache = null) => {
  const hasVal = (keys) => getVal(row, keys) !== undefined;

  // Try to identify if the product already exists matching ID, SKU, or Name
  const rowId = getVal(row, ["Product ID", "id", "ID"]);
  const rowSku = getVal(row, ["SKU", "sku"]);
  const rowName = getVal(row, ["Product Name", "Name", "name", "Title"]);

  let existingProduct = null;

  if (existingProductsCache && Array.isArray(existingProductsCache)) {
    const idToFind = rowId && !isNaN(Number(rowId)) ? Number(rowId) : null;
    const skuToFind = rowSku ? String(rowSku).trim().toLowerCase() : null;
    const nameToFind = rowName ? String(rowName).trim().toLowerCase() : null;

    existingProduct = existingProductsCache.find(p => {
      if (idToFind !== null && p.id === idToFind) return true;
      if (skuToFind !== null && p.sku && p.sku.toLowerCase() === skuToFind) return true;
      if (nameToFind !== null && p.name && p.name.toLowerCase() === nameToFind) return true;
      return false;
    });
  }

  if (!existingProduct) {
    if (rowId && !isNaN(Number(rowId))) {
      existingProduct = await Product.findOne({ id: Number(rowId) });
    }
    if (!existingProduct && rowSku && String(rowSku).trim()) {
      existingProduct = await Product.findOne({ sku: String(rowSku).trim() });
    }
    if (!existingProduct && rowName && String(rowName).trim()) {
      existingProduct = await Product.findOne({ name: { $regex: new RegExp("^" + String(rowName).trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + "$", "i") } });
    }
  }

  if (existingProduct) {
    // UPDATE MODE: Update only the provided fields in Excel row
    if (hasVal(["Product Name", "Name", "name", "Title"])) {
      existingProduct.name = String(rowName).trim();
    }
    if (hasVal(["SKU", "sku"])) {
      existingProduct.sku = String(rowSku).trim();
    }

    let slugVal = getVal(row, ["Slug", "slug"]);
    if (slugVal !== undefined) {
      existingProduct.slug = String(slugVal).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    } else if (hasVal(["Product Name", "Name", "name", "Title"])) {
      existingProduct.slug = String(rowName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    }

    if (hasVal(["Brand", "brand"])) {
      existingProduct.brand = String(getVal(row, ["Brand", "brand"]) || "").trim();
    }
    if (hasVal(["Category", "category"])) {
      existingProduct.category = String(getVal(row, ["Category", "category"]) || "").trim();
    }
    if (hasVal(["Subcategory", "subcategory"])) {
      existingProduct.subcategory = String(getVal(row, ["Subcategory", "subcategory"]) || "").trim();
    }
    if (hasVal(["Price", "price", "Rate", "Cost"])) {
      const priceVal = Number(getVal(row, ["Price", "price", "Rate", "Cost"]));
      if (!isNaN(priceVal)) existingProduct.price = priceVal;
    }
    if (hasVal(["Stock", "stock", "Quantity", "Qty"])) {
      const stockVal = Number(getVal(row, ["Stock", "stock", "Quantity", "Qty"]));
      if (!isNaN(stockVal)) existingProduct.stock = stockVal;
    }
    if (hasVal(["Weight Kg", "weightKg", "Weight (Kg)", "Weight", "weight"])) {
      const weightVal = Number(getVal(row, ["Weight Kg", "weightKg", "Weight (Kg)", "Weight", "weight"]));
      if (!isNaN(weightVal)) existingProduct.weightKg = weightVal;
    }

    const lenVal = getVal(row, ["Length cm", "length", "Length (cm)", "Length", "length"]);
    const widVal = getVal(row, ["Width cm", "width", "Width (cm)", "Width", "width"]);
    const heiVal = getVal(row, ["Height cm", "height", "Height (cm)", "Height", "height"]);
    if (lenVal !== undefined || widVal !== undefined || heiVal !== undefined) {
      const d = { ...(existingProduct.dimensions || { length: 0, width: 0, height: 0 }) };
      if (lenVal !== undefined && !isNaN(Number(lenVal))) d.length = Number(lenVal);
      if (widVal !== undefined && !isNaN(Number(widVal))) d.width = Number(widVal);
      if (heiVal !== undefined && !isNaN(Number(heiVal))) d.height = Number(heiVal);
      existingProduct.dimensions = d;
    }

    if (hasVal(["Description", "description", "Desc"])) {
      existingProduct.description = String(getVal(row, ["Description", "description", "Desc"]) || "").trim();
    }
    if (hasVal(["Main Image URL", "Image", "image", "Thumbnail"])) {
      existingProduct.image = String(getVal(row, ["Main Image URL", "Image", "image", "Thumbnail"]) || "").trim();
    }
    if (hasVal(["Additional Images", "images", "Images"])) {
      const additionalImagesText = getVal(row, ["Additional Images", "images", "Images"]) || "";
      const imagesArr = typeof additionalImagesText === 'string'
        ? additionalImagesText.split(",").map(img => img.trim()).filter(img => img !== "")
        : (additionalImagesText ? [String(additionalImagesText)] : []);
      existingProduct.images = imagesArr.map(url => ({ url, publicId: "" }));
    }
    if (hasVal(["Technical PDF Catalogue", "Catalogue", "catalogue", "PDF"])) {
      existingProduct.catalogue = String(getVal(row, ["Technical PDF Catalogue", "Catalogue", "catalogue", "PDF"]) || "").trim();
    }
    if (hasVal(["Keywords (comma separated)", "Keywords", "keywords", "Tags"])) {
      existingProduct.keywords = String(getVal(row, ["Keywords (comma separated)", "Keywords", "keywords", "Tags"]) || "").trim();
    }
    if (hasVal(["HSN Code", "hsnCode", "HSN"])) {
      existingProduct.hsnCode = String(getVal(row, ["HSN Code", "hsnCode", "HSN"]) || "").trim();
    }
    if (hasVal(["Features (One per line)", "Features", "features"])) {
      const featuresText = getVal(row, ["Features (One per line)", "Features", "features"]) || "";
      const featuresArr = typeof featuresText === 'string'
        ? featuresText.split(/\n|,/).map(f => f.trim()).filter(f => f !== "")
        : [String(featuresText)];
      existingProduct.features = featuresArr;
    }
    if (hasVal(["Specifications (Key: Value per line)", "Specifications", "specifications", "Specs"])) {
      const specsText = getVal(row, ["Specifications (Key: Value per line)", "Specifications", "specifications", "Specs"]) || "";
      const specificationsObj = {};
      if (typeof specsText === 'string') {
        specsText.split("\n").forEach(line => {
          const [key, ...valParts] = line.split(":");
          if (key && valParts.length > 0) {
            specificationsObj[key.trim()] = valParts.join(":").trim();
          }
        });
      }
      existingProduct.specifications = specificationsObj;
    }
    if (hasVal(["Active", "isActive", "Status"])) {
      const activeVal = String(getVal(row, ["Active", "isActive", "Status"]) || "").toLowerCase();
      existingProduct.isActive = activeVal === "true" || activeVal === "yes" || activeVal === "active" || activeVal === "1";
    }

    await existingProduct.save();
    return existingProduct;
  } else {
    // CREATE MODE: Require Product Name and Price
    if (!rowName || !String(rowName).trim()) {
      throw new Error("Product Name is required for creating a new product");
    }
    const price = getVal(row, ["Price", "price", "Rate", "Cost"]);
    if (price === undefined || isNaN(Number(price))) {
      throw new Error("Valid Price is required for creating a new product");
    }

    // Parse Features (split by newline or comma)
    const featuresText = getVal(row, ["Features (One per line)", "Features", "features"]) || "";
    const features = typeof featuresText === 'string'
      ? featuresText.split(/\n|,/).map(f => f.trim()).filter(f => f !== "")
      : [String(featuresText)];

    // Parse Specifications (Key: Value per line)
    const specsText = getVal(row, ["Specifications (Key: Value per line)", "Specifications", "specifications", "Specs"]) || "";
    const specifications = {};
    if (typeof specsText === 'string') {
      specsText.split("\n").forEach(line => {
        const [key, ...valParts] = line.split(":");
        if (key && valParts.length > 0) {
          specifications[key.trim()] = valParts.join(":").trim();
        }
      });
    }

    // Parse Additional Images (comma separated)
    const additionalImagesText = getVal(row, ["Additional Images", "images", "Images"]) || "";
    const images = typeof additionalImagesText === 'string'
      ? additionalImagesText.split(",").map(img => img.trim()).filter(img => img !== "")
      : (additionalImagesText ? [String(additionalImagesText)] : []);

    let slug = getVal(row, ["Slug", "slug"]) || "";
    if (!slug) {
      slug = String(rowName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    }

    const weightKg = Number(getVal(row, ["Weight Kg", "weightKg", "Weight (Kg)", "Weight", "weight"])) || 0;
    const length = Number(getVal(row, ["Length cm", "length", "Length (cm)", "Length", "length"])) || 0;
    const width = Number(getVal(row, ["Width cm", "width", "Width (cm)", "Width", "width"])) || 0;
    const height = Number(getVal(row, ["Height cm", "height", "Height (cm)", "Height", "height"])) || 0;

    const productData = {
      id: Number(rowId) || undefined,
      name: String(rowName).trim(),
      sku: String(rowSku || "").trim(),
      slug: slug,
      brand: String(getVal(row, ["Brand", "brand"]) || "").trim(),
      category: String(getVal(row, ["Category", "category"]) || "").trim(),
      subcategory: String(getVal(row, ["Subcategory", "subcategory"]) || "").trim(),
      price: Number(price),
      stock: Number(getVal(row, ["Stock", "stock", "Quantity", "Qty"]) || 0),
      weightKg: weightKg,
      dimensions: { length, width, height },
      description: String(getVal(row, ["Description", "description", "Desc"]) || "").trim(),
      image: String(getVal(row, ["Main Image URL", "Image", "image", "Thumbnail"]) || "").trim(),
      images: images.map(url => ({ url, publicId: "" })),
      catalogue: String(getVal(row, ["Technical PDF Catalogue", "Catalogue", "catalogue", "PDF"]) || "").trim(),
      keywords: String(getVal(row, ["Keywords (comma separated)", "Keywords", "keywords", "Tags"]) || "").trim(),
      hsnCode: String(getVal(row, ["HSN Code", "hsnCode", "HSN"]) || "").trim(),
      features: features,
      specifications: specifications,
      isActive: true
    };

    const newProduct = new Product(productData);
    await newProduct.save();
    return newProduct;
  }
};

app.post("/api/admin/products/bulk-import", auth, adminOnly, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No Excel file uploaded" });

  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    console.log(`Bulk Import: Processing ${data.length} rows from sheet "${sheetName}"`);

    if (data.length === 0) {
      return res.json({ success: true, message: "No data found in the Excel file", totalRows: 0 });
    }

    const importedProducts = [];
    const errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowIndex = i + 2;
      try {
        const product = await importProductRow(row, rowIndex);
        importedProducts.push(product);
      } catch (err) {
        console.error(`Error processing row ${rowIndex}:`, err);
        errors.push(`Row ${rowIndex}: ${err.message}`);
      }
    }

    res.json({
      success: true,
      message: `Imported/Updated ${importedProducts.length} products successfully`,
      totalRows: data.length,
      importedCount: importedProducts.length,
      errors: errors.length > 0 ? errors : null
    });
  } catch (error) {
    console.error("Bulk Import Error:", error);
    sendErrorResponse(res, error, "Failed to process Excel file");
  }
});

app.post("/api/admin/products/import-batch", auth, adminOnly, async (req, res) => {
  try {
    const { products, startRowIndex } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ message: "No product data provided" });
    }

    const startRow = Number(startRowIndex) || 2;
    const importedProducts = [];
    const errors = [];
    const failures = [];

    // Pre-fetch matching existing products for optimization
    const ids = [];
    const skus = [];
    const names = [];

    products.forEach(row => {
      const rowId = getVal(row, ["Product ID", "id", "ID"]);
      const rowSku = getVal(row, ["SKU", "sku"]);
      const rowName = getVal(row, ["Product Name", "Name", "name", "Title"]);

      if (rowId && !isNaN(Number(rowId))) ids.push(Number(rowId));
      if (rowSku && String(rowSku).trim()) skus.push(String(rowSku).trim());
      if (rowName && String(rowName).trim()) names.push(String(rowName).trim());
    });

    const orConditions = [];
    if (ids.length > 0) orConditions.push({ id: { $in: ids } });
    if (skus.length > 0) orConditions.push({ sku: { $in: skus } });
    if (names.length > 0) {
      names.forEach(name => {
        const escaped = name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        orConditions.push({ name: { $regex: new RegExp("^" + escaped + "$", "i") } });
      });
    }

    let existingProductsCache = [];
    if (orConditions.length > 0) {
      existingProductsCache = await Product.find({ $or: orConditions });
    }

    for (let i = 0; i < products.length; i++) {
      const row = products[i];
      const rowIndex = startRow + i;
      try {
        const product = await importProductRow(row, rowIndex, existingProductsCache);
        importedProducts.push(product);
      } catch (err) {
        console.error(`Error processing row ${rowIndex}:`, err);
        const errMsg = err.message || "Unknown error";
        errors.push(`Row ${rowIndex}: ${errMsg}`);
        failures.push({
          rowIndex,
          rowData: row,
          error: errMsg
        });
      }
    }

    res.json({
      success: true,
      importedCount: importedProducts.length,
      errors: errors.length > 0 ? errors : null,
      failures: failures.length > 0 ? failures : null
    });
  } catch (error) {
    console.error("Batch Import Error:", error);
    sendErrorResponse(res, error, "Failed to process batch");
  }
});

// --- AI Chatbot Endpoint ---
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history } = req.body;

    // Log for debugging
    const hasKey = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_actual_gemini_api_key_here';
    console.log(`[Chat] Request received. Live AI Mode: ${hasKey}`);

    // Fetch active products for context with full catalog details
    const products = await Product.find({ isActive: true })
      .select('name category subcategory price features sku brand keywords weightKg dimensions specifications description')
      .lean();

    // 1. Demo Mode Fallback
    if (!hasKey) {
      console.warn("⚠️ [Chat] Gemini API key missing. Running in Demo Mode.");

      const query = (message || "").toLowerCase();
      const matchedProducts = products.filter(p =>
        (p.name || "").toLowerCase().includes(query) ||
        (p.brand || "").toLowerCase().includes(query) ||
        (p.category || "").toLowerCase().includes(query)
      ).slice(0, 3);

      let reply = "";
      if (matchedProducts.length > 0) {
        reply = `I found some products that might interest you:\n\n` +
          matchedProducts.map(p => `* **${p.name}** (SKU: ${p.sku}) - ₹${p.price}`).join('\n') +
          `\n\n*(Note: I am currently in Demo Mode. Add a real GEMINI_API_KEY to .env for full AI features.)*`;
      } else {
        reply = "I'm currently in **Demo Mode** because no `GEMINI_API_KEY` was found in the environment. Please add your key to the `.env` file to enable the full AI assistant!";
      }

      return res.json({ reply });
    }

    // 2. Live AI Mode
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // --- NEW: Context Optimization (Local Token Pre-Filter) ---
    const searchTerms = (message || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let matchedProducts = [];

    if (searchTerms.length > 0) {
      matchedProducts = products.filter(p => {
        const productText = `${p.name} ${p.sku} ${p.category} ${p.subcategory} ${p.brand} ${p.description} ${Array.isArray(p.keywords) ? p.keywords.join(' ') : p.keywords || ''}`.toLowerCase();
        // Check if ANY of the search terms appear in the product metadata
        return searchTerms.some(term => productText.includes(term));
      }).slice(0, 15); // Cap to 15 products max to save Tokens
    }

    if (matchedProducts.length === 0) {
      // Just grab first 5 items for generic hellos
      matchedProducts = products.slice(0, 5);
    }

    const productContext = matchedProducts.map(p => {
      let dimensionsStr = 'N/A';
      if (p.dimensions && (p.dimensions.length || p.dimensions.width || p.dimensions.height)) {
        dimensionsStr = `${p.dimensions.length || 0}x${p.dimensions.width || 0}x${p.dimensions.height || 0} mm`;
      }
      const specsStr = p.specifications ? Object.entries(p.specifications).map(([k, v]) => `${k}: ${v}`).join(', ') : 'N/A';
      return `- Name: ${p.name}
  SKU: ${p.sku}
  Brand: ${p.brand || 'N/A'}
  Category: ${p.category || 'N/A'} (Subcategory: ${p.subcategory || 'N/A'})
  Price: ₹${p.price}
  Weight: ${p.weightKg ? p.weightKg + ' kg' : 'N/A'}
  Dimensions (LxWxH): ${dimensionsStr}
  Specifications: ${specsStr}
  Description: ${p.description || 'N/A'}`;
    }).join('\n\n');

    const systemPrompt = `You are an advanced AI Sales & Engineering Assistant for "Fine Bearing".
You have been programmed with a specialized skill: you have real-time access to the complete, live catalog of every product the owner has added to the database.

AVAILABLE LIVE CATALOG (With dimensions, weights, prices, specs):
${productContext}

YOUR SKILLS & RULES:
1. Product Expert Skill: You know everything about the products in the catalog above. You can compare them, find matches based on dimensions, and recommend the best fit for industrial applications.
2. ONLY recommend products from the provided catalog above. Do not invent products.
3. If a product is not in the catalog, politely say you don't carry it but offer the closest alternative from the catalog if possible.
4. Be concise, highly professional, and helpful. 
5. Use Markdown for formatting (bold names, bullet points, tables where helpful).
6. Always provide the SKU when mentioning a product.
7. Provide specific product information (price, weight, dimensions, specifications, and descriptions) when asked.
8. Add To Cart Skill: For every product recommended or mentioned in your response, ALWAYS append a functional Add to Cart link in the exact format: [Add to Cart](https://add-to-cart/SKU) right after or underneath the product description. Example: [Add to Cart](https://add-to-cart/ucp-204).`;

    // Format history for Gemini SDK
    const formattedHistory = (history || []).map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text || "" }]
    }));

    // System prompt as the first message pair (Most compatible way)
    const compatibleHistory = [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "model", parts: [{ text: "Understood. I am ready to assist with the Fine Bearing catalog." }] },
      ...formattedHistory
    ];

    let responseText = "";
    let lastError = null;

    // Try multiple model versions in order of preference, including preview models for your specific key
    const modelsToTry = [
      "gemini-3.5-flash-lite",
      "gemini-flash-lite-latest",
      "gemini-3.5-flash",
      "gemini-flash-latest"
    ];

    for (const modelName of modelsToTry) {
      try {
        console.log(`[Chat] Attempting with model: ${modelName}...`);
        const model = genAI.getGenerativeModel({ model: modelName });

        const chat = model.startChat({
          history: compatibleHistory,
          generationConfig: { maxOutputTokens: 800, temperature: 0.7 },
        });

        const result = await chat.sendMessage(message);
        const response = await result.response;
        responseText = response.text();

        if (responseText) {
          console.log(`✅ [Chat] Success with model: ${modelName}`);
          break; // Stop once we get a response
        }
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ [Chat] Model ${modelName} failed:`, err.message);
        continue; // Try the next model 
      }
    }

    if (!responseText) {
      throw lastError || new Error("All models failed to respond.");
    }

    // Extract all unique SKUs mentioned in add-to-cart links (handles both add-to-cart: and https://add-to-cart/)
    const skuMatches = [
      ...responseText.matchAll(/add-to-cart:([a-zA-Z0-9_-]+)/g),
      ...responseText.matchAll(/https:\/\/add-to-cart\/([a-zA-Z0-9_-]+)/g)
    ].map(m => m[1].toLowerCase());
    let mentionedProducts = [];
    if (skuMatches.length > 0) {
      try {
        mentionedProducts = await Product.find({
          sku: { $in: skuMatches.map(sku => new RegExp(`^${sku}$`, 'i')) }
        })
          .select('id sku name price image')
          .lean();
      } catch (err) {
        console.error("Error fetching mentioned products for chat:", err);
      }
    }

    res.json({ reply: responseText, products: mentionedProducts });

  } catch (error) {
    console.error("❌ [Chat Error]:", error);

    let userMessage = "Sorry, I encountered an error processing your request.";
    if (error.message?.includes("API_KEY_INVALID") || error.message?.includes("valid API key") || error.message?.includes("API key not valid")) {
      userMessage = "The configured Gemini API Key is invalid or expired. Please generate a new one at aistudio.google.com and update your .env file.";
    } else if (error.message?.includes("safety")) {
      userMessage = "I'm sorry, but I cannot answer that question due to safety filters.";
    } else if (error.message?.includes("retry") || error.message?.includes("429") || error.message?.includes("quota")) {
      userMessage = "I am currently experiencing very high demand and have reached my rate limit. Please wait a minute and try asking again!";
    }

    res.status(200).json({
      message: "Failed to process chat",
      error: error.message,
      reply: userMessage
    });
  }
});

const startServer = async () => {
  await connectDB();

  // --- Cart Synchronization Routes ---

  // GET: Fetch user's cart
  app.get("/api/cart", auth, async (req, res) => {
    try {
      const user = await User.findOne({ firebaseUid: req.user.uid });
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json({ cart: user.cart || [] });
    } catch (error) {
      sendErrorResponse(res, error, "Failed to fetch cart");
    }
  });

  // POST: Sync entire cart to database
  app.post("/api/cart/sync", auth, async (req, res) => {
    const { cart } = req.body; // Expecting an array of items
    try {
      const user = await User.findOne({ firebaseUid: req.user.uid });
      if (!user) return res.status(404).json({ message: "User not found" });

      user.cart = cart;
      await user.save();
      res.json({ success: true, message: "Cart synced successfully" });
    } catch (error) {
      sendErrorResponse(res, error, "Failed to sync cart");
    }
  });

  // --- Analytics Routes ---

  // --- Excel Reports Route ---
  app.get("/api/admin/reports/excel", auth, adminOnly, async (req, res) => {
    try {
      const XLSX = require("xlsx");
      const { startDate, endDate } = req.query;

      // Filter successful orders
      const filter = { "paymentDetails.status": "SUCCESS" };

      // Optional date range
      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) {
          filter.createdAt.$gte = new Date(startDate).toISOString();
        }
        if (endDate) {
          filter.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999)).toISOString();
        }
      }

      const orders = await Order.find(filter).sort({ createdAt: -1 });

      const wb = XLSX.utils.book_new();

      // Sheet 1: GST Sales Register
      const registerData = [
        [
          "Order ID", "Date", "Customer Name", "Company Name", "GSTIN", "State",
          "Taxable Value (₹)", "GST Rate", "CGST (₹)", "SGST (₹)", "IGST (₹)",
          "Shipping Charge (₹)", "Total Value (₹)", "Coupon Code"
        ]
      ];

      orders.forEach(order => {
        const isPunjab = (order.shippingAddress?.state || "").toLowerCase().includes("punjab");
        const subtotal = order.subtotal || 0;
        const gst = order.gstAmount || 0;
        const shipping = order.shippingCharge || 0;
        const total = order.total || 0;
        const cgst = isPunjab ? (gst / 2) : 0;
        const sgst = isPunjab ? (gst / 2) : 0;
        const igst = !isPunjab ? gst : 0;

        registerData.push([
          order.orderId,
          order.createdAt ? order.createdAt.split('T')[0] : "",
          order.shippingAddress?.fullName || "",
          order.shippingAddress?.company || "",
          order.shippingAddress?.gstNumber || "URD",
          order.shippingAddress?.state || "",
          subtotal,
          "18%",
          cgst,
          sgst,
          igst,
          shipping,
          total,
          order.couponCode || ""
        ]);
      });

      const wsRegister = XLSX.utils.aoa_to_sheet(registerData);
      XLSX.utils.book_append_sheet(wb, wsRegister, "GST Sales Register");

      // Sheet 2: Financial Summary
      const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
      const totalTaxable = orders.reduce((sum, o) => sum + (o.subtotal || 0), 0);
      const totalGST = orders.reduce((sum, o) => sum + (o.gstAmount || 0), 0);
      const totalShipping = orders.reduce((sum, o) => sum + (o.shippingCharge || 0), 0);

      const summaryData = [
        ["Financial Metric", "Value"],
        ["Report Start Date", startDate || "All Time"],
        ["Report End Date", endDate || "All Time"],
        ["Total Orders", orders.length],
        ["Total Revenue (Gross) (₹)", totalRevenue],
        ["Total Taxable Sales (₹)", totalTaxable],
        ["Total GST Collected (₹)", totalGST],
        ["Total Shipping Charges (₹)", totalShipping],
        ["Avg. Order Value (₹)", orders.length > 0 ? (totalRevenue / orders.length) : 0]
      ];

      const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(wb, wsSummary, "Financial Summary");

      // Sheet 3: Product Sales Breakdown
      const productSales = {};
      orders.forEach(order => {
        (order.items || []).forEach(item => {
          const key = item.name || "Unknown Product";
          if (!productSales[key]) {
            productSales[key] = { qty: 0, revenue: 0 };
          }
          productSales[key].qty += (item.quantity || 0);
          productSales[key].revenue += (item.totalPrice || 0);
        });
      });

      const productData = [
        ["Product Name", "Total Quantity Sold", "Total Revenue (₹)"]
      ];
      Object.entries(productSales).forEach(([name, stats]) => {
        productData.push([name, stats.qty, stats.revenue]);
      });

      const wsProducts = XLSX.utils.aoa_to_sheet(productData);
      XLSX.utils.book_append_sheet(wb, wsProducts, "Product Sales Breakdown");

      // Write to a buffer
      const excelBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader("Content-Disposition", `attachment; filename=GST_Tax_Report_${Date.now()}.xlsx`);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      return res.send(excelBuffer);
    } catch (error) {
      console.error("Excel Generation Error:", error);
      return res.status(500).json({ message: "Failed to generate report", error: error.message });
    }
  });

  app.get("/api/admin/analytics", auth, adminOnly, async (req, res) => {
    try {
      const orders = await Order.find({ "paymentDetails.status": "SUCCESS" });

      // 1. Basic KPIs
      const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
      const totalOrders = orders.length;
      const totalWeight = orders.reduce((sum, o) => sum + (o.shippingDetails?.totalWeight || 0), 0);

      // 2. Revenue by Shipping Zone
      const zoneStats = {};
      orders.forEach(o => {
        const zone = o.shippingDetails?.zone || "Unassigned";
        zoneStats[zone] = (zoneStats[zone] || 0) + (o.total || 0);
      });

      // 3. Sales Trend (Last 7 Days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Initialize last 7 days with zero
      const dailyStatsMap = {};
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dailyStatsMap[d.toISOString().split('T')[0]] = 0;
      }

      orders.forEach(o => {
        const dateKey = new Date(o.createdAt).toISOString().split('T')[0];
        if (dailyStatsMap.hasOwnProperty(dateKey)) {
          dailyStatsMap[dateKey] += o.total;
        }
      });

      const dailyStats = Object.keys(dailyStatsMap)
        .sort()
        .map(date => ({
          date: new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
          revenue: dailyStatsMap[date]
        }));

      // 4. Status Distribution
      const allOrders = await Order.find({});
      const statusStats = {};
      allOrders.forEach(o => {
        statusStats[o.status] = (statusStats[o.status] || 0) + 1;
      });

      res.json({
        summary: {
          totalRevenue,
          totalOrders,
          totalWeight,
          averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0
        },
        zoneData: Object.keys(zoneStats).map(name => ({ name, value: zoneStats[name] })),
        trendData: dailyStats,
        statusData: Object.keys(statusStats).map(name => ({ name, value: statusStats[name] }))
      });
    } catch (error) {
      console.error("Analytics Error:", error);
      sendErrorResponse(res, error, "Failed to load analytics");
    }
  });

  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
};

startServer();

module.exports = app;

// Trigger restart
