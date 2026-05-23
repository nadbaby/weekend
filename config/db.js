const mongoose = require("mongoose");

let cachedPromise = null;

const connectDB = async () => {
  // 1. If already connected, do a health check
  if (mongoose.connection.readyState === 1) {
    try {
      await Promise.race([
        mongoose.connection.db.admin().ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 1000))
      ]);
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
        socketTimeoutMS: 45000,
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
