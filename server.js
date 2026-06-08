const path = require("path");
const dns = require("dns");
// Fix for MongoDB Atlas DNS resolution issues
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config();
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
const Product = require("./models/Product");
const User = require("./models/User");
const Employee = require("./models/Employee");
const Order = require("./models/Order");
const Quote = require("./models/Quote");
const Ticket = require("./models/Ticket");
const admin = require("firebase-admin");
const cloudinary = require("cloudinary").v2;

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
const PORT = process.env.PORT || 5000;

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
  // Capture raw body for webhook verification
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith('/api/payment/webhook')) {
      req.rawBody = buf;
    }
  }
}));

// --- Rate Limiting ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100000, // Increased to 100,000 to prevent developer lockout during rapid reloads/testing
  message: "Too many requests from this IP, please try again after 15 minutes"
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10000, // Increased to 10,000 for development testing
  message: "Too many login attempts, please try again after an hour"
});

app.use("/api/", globalLimiter);
app.use("/api/auth/login", authLimiter);

// Specialized limiter for payment creation (High Risk)
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5000, // Increased to 5000 for development testing
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
app.use("/api/shipping", shippingRoutes);
app.use("/api/user", auth, userRoutes);
const multer = require("multer");
const { sendOtp, verifyOtp, sendSMSOrderAlert, sendAdminNewOrderAlert } = require("./twiloapi");

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
    res.status(500).json({ message: "Image upload failed", error: error.message });
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
    res.status(500).json({ message: "Failed to process PDF", error: error.message });
  }
});


const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";
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
  const trimmedUsername = username ? username.trim() : "";

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
      username: employee.username,
      role: userRole,
      permissions: employee.permissions
    }, JWT_SECRET, { expiresIn: "7d" });

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
      username: user.username || user.phone,
      role: "user"
    }, JWT_SECRET, { expiresIn: "7d" });

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
    res.status(500).json({ message: "Failed to fetch profile", error: error.message });
  }
});

// Sync Firebase User with MongoDB
app.post("/api/auth/sync", auth, async (req, res) => {
  const { name, company, phone, gstNumber } = req.body;
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
        phone: phone || "",
        role: "user"
      });
      await user.save();
    }

    res.json({
      success: true,
      message: "User synced successfully",
      user: user
    });
  } catch (err) {
    console.error("Sync Error:", err);
    res.status(500).json({ message: "Failed to sync user", error: err.message });
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

  const token = jwt.sign({ username: phone, role: "user" }, JWT_SECRET, { expiresIn: "7d" });

  res.json({
    success: true,
    token,
    user: existingUser || { username: phone, role: "user", phone: phone }
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

    const token = jwt.sign({ username, role: "user" }, JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({
      success: true,
      token,
      user: newUser
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Failed to create user", error: error.message });
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

  const token = jwt.sign({ username: phone, role: "user" }, JWT_SECRET, { expiresIn: "7d" });

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
    res.status(500).json({ message: "Failed to send SMS alert", error: error.message });
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
    const imagePart = {
      inlineData: {
        data: req.file.buffer.toString("base64"),
        mimeType: req.file.mimetype
      }
    };

    // 2. Fetch active products for catalog context
    const products = await Product.find({ isActive: true })
      .select('name category price sku brand keywords description')
      .lean();

    // Limit catalog context to keep token count reasonable
    const productContext = products.map(p =>
      `- SKU: ${p.sku} | Name: ${p.name} | Category: ${p.category} | Brand: ${p.brand}`
    ).join('\n');

    // 3. Initialize Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // Use gemini-2.5-flash which is perfect for multimodal/vision tasks
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `You are an industrial engineering assistant specialized in bearings and oil seals.
Analyze the provided image of a bearing or oil seal, and identify its type, approximate dimensions, and features.
Then, compare it to our available catalog below and find the top 3 best matching products.

AVAILABLE CATALOG:
${productContext}

Respond strictly in valid JSON format. Do not write markdown blocks or any conversational text around the JSON.
Format the response exactly as follows:
{
  "detectedType": "Deep Groove Ball Bearing",
  "reasoning": "The image shows a ball bearing with single-row deep groove design.",
  "matches": [
    {
      "sku": "SKU_OF_MATCH_1",
      "confidence": 95,
      "reason": "Visual attributes match this SKU exactly."
    },
    {
      "sku": "SKU_OF_MATCH_2",
      "confidence": 75,
      "reason": "Similar shape, but size might differ."
    }
  ]
}`;

    const result = await model.generateContent([prompt, imagePart]);
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
    res.status(500).json({ message: "AI vision search failed", error: error.message });
  }
});


// GET product autocomplete search suggestions
app.get("/api/products/autocomplete", async (req, res) => {
  try {
    const query = req.query.q ? req.query.q.trim() : "";
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
    res.status(500).json({ message: "Search suggestions failed" });
  }
});

// GET all products (MongoDB)
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.find({}).sort({ id: 1 });
    res.json(products);
  } catch (error) {
    console.error("Failed to read products:", error);
    res.status(500).json({
      message: "Failed to read products",
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
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
    } else {
      product = await Product.findOne({ slug: param });
    }


    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(product);
  } catch (error) {
    console.error("Failed to read product:", error);
    res.status(500).json({ message: "Failed to read product" });
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
    res.status(500).json({ message: "Failed to create product", error: error.message });
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
    res.status(500).json({ message: "Failed to update product", error: error.message });
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

    if (gstUsageCount + 1 !== rule.milestone) {
      if (gstUsageCount + 1 < rule.milestone) {
        return res.status(400).json({ message: `This is for GST purchase #${rule.milestone}. This GST has ${gstUsageCount} past purchases.` });
      } else {
        return res.status(400).json({ message: "This GST has already used or passed this milestone coupon." });
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
    res.status(500).json({ message: "Coupon validation failed" });
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
      const order = await Order.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
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

      logAudit("PAYMENT_VERIFIED_CLIENT", req.user.uid || req.user.username, { orderId: order?.orderId });
      res.json({ success: true, message: "Payment verified successfully", order });
    } else {
      logAudit("PAYMENT_VERIFICATION_FAILED", req.user.uid || req.user.username, { razorpayOrderId: razorpay_order_id });
      res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (error) {
    res.status(500).json({ message: "Verification failed", error: error.message });
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
    res.status(500).json({ success: false, message: error.message });
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
        { razorpayOrderId: orderId },
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

  // SECURITY: Only allow users to fetch their own orders, or Admins/Employees
  if (requesterId !== username && req.user.role !== 'admin' && req.user.role !== 'employee') {
    logAudit("UNAUTHORIZED_ORDER_FETCH_ATTEMPT", requesterId, { targetUser: username });
    return res.status(403).json({ message: "Forbidden: You can only view your own orders" });
  }

  try {
    const username = req.params.username;
    const orders = await Order.find({
      $or: [
        { userId: username },
        { "shippingAddress.phone": username },
        { "shippingAddress.email": username }
      ],
      status: { $ne: "PENDING" }, // Don't show failed/pending orders in history
      hiddenFromUser: { $ne: true } // Don't show hidden orders
    }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// HIDE order from user history
app.patch("/api/orders/:orderId/hide", auth, async (req, res) => {
  const { orderId } = req.params;
  const userId = req.user.uid || req.user.username;

  try {
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // SECURITY: Ensure only the owner (by UID, username, or shipping contact) or Admin can hide it
    const isOwner = order.userId === userId ||
      order.shippingAddress?.email === userId ||
      order.shippingAddress?.phone === userId;

    if (!isOwner && req.user.role !== 'admin' && req.user.role !== 'employee') {
      logAudit("UNAUTHORIZED_ORDER_HIDE_ATTEMPT", userId, { orderId });
      return res.status(403).json({ message: "Forbidden" });
    }

    order.hiddenFromUser = true;
    await order.save();

    logAudit("ORDER_HIDDEN", userId, { orderId });
    res.json({ success: true, message: "Order removed from history" });
  } catch (error) {
    res.status(500).json({ message: "Failed to hide order" });
  }
});

// GET all orders (for Employee/Admin Panel)
app.get("/api/admin/orders", auth, employeeOrAdmin, async (req, res) => {
  try {
    const orders = await Order.find({}).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch all orders", error: error.message });
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

    // Automatically send SMS alert if phone number is available
    const customerPhone = order.shippingAddress?.phone || order.userId;
    if (customerPhone) {
      console.log(`Triggering SMS alert for order ${orderId} to ${customerPhone}`);
      sendSMSOrderAlert(customerPhone, orderId, status)
        .catch(err => console.error("Auto SMS Alert Error:", err));
    } else {
      console.log(`No phone number found for order ${orderId}, skipping SMS alert.`);
    }

    res.json({ success: true, message: "Status updated", order });
  } catch (error) {
    res.status(500).json({ message: "Failed to update order status" });
  }
});

// Employee Management (Admin Only)
app.get("/api/admin/employees", auth, adminOnly, async (req, res) => {
  try {
    const employees = await Employee.find({});
    res.json(employees);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch employees" });
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
    res.status(500).json({ message: "Failed to create employee" });
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
    res.status(500).json({ message: "Failed to update employee" });
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
    res.status(500).json({ message: "Failed to delete employee" });
  }
});

// User Management (Admin Only)
app.get("/api/admin/users", auth, adminOrManager, async (req, res) => {
  try {
    const users = await User.find({});
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch users", error: error.message });
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
    res.status(500).json({ message: "Failed to update user discount" });
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
    res.status(500).json({ message: "Failed to update user GST" });
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

    await Product.deleteOne({ id });
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Failed to delete product:", error);
    res.status(500).json({ message: "Failed to delete product" });
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
    res.status(500).json({ message: "Failed to update profile" });
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
    if (googleSheetUrl) {
      try {
        const https = require("https");
        const dataString = JSON.stringify(quoteData);

        const options = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': dataString.length,
          },
          timeout: 5000,
        };

        const reqGS = https.request(googleSheetUrl, options);
        reqGS.on('error', (e) => console.error("Google Sheet Forwarding Error:", e));
        reqGS.write(dataString);
        reqGS.end();
      } catch (gsError) {
        console.error("Failed to forward to Google Sheets:", gsError);
      }
    }

    res.status(201).json({ success: true, message: "Quote request received", quoteId });
  } catch (error) {
    console.error("Quote Request Error:", error);
    res.status(500).json({ message: "Failed to process quote request" });
  }
});

// GET My Quotes
app.get("/api/quotes/my-quotes", auth, async (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    const quotes = await Quote.find({ userId: username }).sort({ createdAt: -1 });
    res.json(quotes);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch quotes" });
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
      } catch (err) {}
    }
    const isStaff = ["admin", "employee", "staff", "manager"].includes(userRole?.toLowerCase());

    if (!isOwner && !isStaff) {
      return res.status(403).json({ message: "Forbidden: Access denied" });
    }

    res.json(quote);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch quote details" });
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
    res.status(500).json({ message: "Failed to process negotiation response" });
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
    res.status(500).json({ message: "Failed to convert quote to order" });
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
    res.status(500).json({ message: "Failed to initialize payment" });
  }
});

// GET All Quotes (Staff/Admin)
app.get("/api/admin/quotes", auth, employeeOrAdmin, async (req, res) => {
  try {
    const quotes = await Quote.find({}).sort({ updatedAt: -1 });
    res.json(quotes);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch quotes" });
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
    res.status(500).json({ message: "Failed to submit pricing offer" });
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
    res.status(500).json({ message: "Failed to fetch shipping config" });
  }
});

app.put("/api/admin/shipping-config", auth, authorize(['admin']), async (req, res) => {
  try {
    const config = await ShippingConfig.findOneAndUpdate({}, req.body, { new: true, upsert: true });
    logAudit("SHIPPING_CONFIG_UPDATED", req.user.username, { config: req.body });
    res.json(config);
  } catch (error) {
    res.status(500).json({ message: "Failed to update shipping config" });
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
    res.status(500).json({ message: error.message });
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
    res.status(500).json({ message: error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Backend is live");
});

// System Health Check (for debugging)
app.get("/api/admin/health-check", async (req, res) => {
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
    res.status(500).json({ message: "Failed to create ticket", error: error.message });
  }
});


// Connect to MongoDB, then start server


// Get My Tickets
app.get("/api/tickets/my-tickets/:identifier", auth, async (req, res) => {
  try {
    const tickets = await Ticket.find({ userIdentifier: req.params.identifier });
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch tickets" });
  }
});

// Get Ticket Detail
app.get("/api/tickets/:id", auth, async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch ticket" });
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
    res.status(500).json({ message: "Failed to add reply" });
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
    res.status(500).json({ message: "Failed to update ticket" });
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
    res.status(500).json({ message: "Failed to assign ticket" });
  }
});


// Bulk Import Products (Admin Only)
const XLSX = require("xlsx");
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

    // Helper to find a value in a row regardless of header case/spacing
    const getVal = (row, keys) => {
      const rowKeys = Object.keys(row);
      for (const k of keys) {
        const foundKey = rowKeys.find(rk => rk.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (foundKey !== undefined) return row[foundKey];
      }
      return undefined;
    };

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        const hasVal = (keys) => getVal(row, keys) !== undefined;

        // Try to identify if the product already exists matching ID, SKU, or Name
        const rowId = getVal(row, ["Product ID", "id", "ID"]);
        const rowSku = getVal(row, ["SKU", "sku"]);
        const rowName = getVal(row, ["Product Name", "Name", "name", "Title"]);

        let existingProduct = null;

        if (rowId && !isNaN(Number(rowId))) {
          existingProduct = await Product.findOne({ id: Number(rowId) });
        }
        if (!existingProduct && rowSku && String(rowSku).trim()) {
          existingProduct = await Product.findOne({ sku: String(rowSku).trim() });
        }
        if (!existingProduct && rowName && String(rowName).trim()) {
          existingProduct = await Product.findOne({ name: { $regex: new RegExp("^" + String(rowName).trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + "$", "i") } });
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
          importedProducts.push(existingProduct);
        } else {
          // CREATE MODE: Require Product Name and Price
          if (!rowName || !String(rowName).trim()) {
            errors.push(`Row ${i + 2}: Product Name is required for creating a new product`);
            continue;
          }
          const price = getVal(row, ["Price", "price", "Rate", "Cost"]);
          if (price === undefined || isNaN(Number(price))) {
            errors.push(`Row ${i + 2}: Valid Price is required for creating a new product`);
            continue;
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
          importedProducts.push(newProduct);
        }
      } catch (err) {
        console.error(`Error processing row ${i + 2}:`, err);
        errors.push(`Row ${i + 2}: ${err.message}`);
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
    res.status(500).json({ message: "Failed to process Excel file", error: error.message });
  }
});

// --- AI Chatbot Endpoint ---
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history } = req.body;

    // Log for debugging
    const hasKey = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_actual_gemini_api_key_here';
    console.log(`[Chat] Request received. Live AI Mode: ${hasKey}`);

    // Fetch active products for context
    const products = await Product.find({ isActive: true })
      .select('name category price features sku brand keywords')
      .limit(50)
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

    const productContext = products.map(p =>
      `- ${p.name} (SKU: ${p.sku}): Brand ${p.brand}, Category ${p.category}, Price ₹${p.price}.`
    ).join('\n');

    const systemPrompt = `You are a professional industrial product expert for "Fine Bearing".
    
AVAILABLE CATALOG:
${productContext}

RULES:
1. ONLY recommend products from the provided catalog above.
2. If a product is not in the catalog, politely say you don't carry it but offer the closest alternative if possible.
3. Be concise, professional, and helpful.
4. Use Markdown for formatting (bold names, bullet points).
5. Always provide the SKU when mentioning a product.`;

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
      "gemini-2.5-flash",
      "gemini-flash-latest",
      "gemini-3.1-flash-preview",
      "gemini-1.5-flash",
      "gemini-pro"
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

    res.json({ reply: responseText });

  } catch (error) {
    console.error("❌ [Chat Error]:", error);

    let userMessage = "Sorry, I encountered an error processing your request.";
    if (error.message?.includes("API_KEY_INVALID")) {
      userMessage = "The configured Gemini API Key is invalid. Please check your .env file.";
    } else if (error.message?.includes("safety")) {
      userMessage = "I'm sorry, but I cannot answer that question due to safety filters.";
    }

    res.status(500).json({
      message: "Failed to process chat",
      error: error.message,
      reply: userMessage + " (Check server logs for details)"
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
      res.status(500).json({ message: "Failed to fetch cart", error: error.message });
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
      res.status(500).json({ message: "Failed to sync cart", error: error.message });
    }
  });

  // --- Analytics Routes ---

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
      res.status(500).json({ message: "Failed to load analytics", error: error.message });
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

