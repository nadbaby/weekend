const mongoose = require("mongoose");

let cachedPromise = null;
let lastPingTime = 0;
const PING_INTERVAL_MS = 30000; // Ping at most every 30 seconds

const connectDB = async () => {
  // 1. If already connected, do a health check only if interval has passed
  if (mongoose.connection.readyState === 1) {
    const now = Date.now();
    if (now - lastPingTime < PING_INTERVAL_MS) {
      return true;
    }
    try {
      await Promise.race([
        mongoose.connection.db.admin().ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 1000))
      ]);
      lastPingTime = now;
      return true;
    } catch (error) {
      console.warn("⚠️ Stale connection, reconnecting...");
      await mongoose.disconnect();
      cachedPromise = null;
    }
  }

  // 2. If a connection is already in progress, wait for it
  if (cachedPromise) {
    return cachedPromise;
  }

  // 3. Start a new connection and "lock" it
  cachedPromise = (async () => {
    try {
      console.log("Attempting fresh MongoDB connection...");
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 180000, // Increased to 3 min to allow initial 5000-item bulk query to finish without dropping
        bufferCommands: false,
      });
      console.log("✅ MongoDB Connected Successfully");
      return true;
    } catch (error) {
      console.error(`❌ MongoDB Connection Error: ${error.message}`);
      cachedPromise = null; // Reset lock on failure
      return false;
    }
  })();

  return cachedPromise;
};

module.exports = connectDB;
