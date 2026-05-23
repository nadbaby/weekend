const mongoose = require('mongoose');
const admin = require('firebase-admin');
require('dotenv').config();

// 1. Init Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 2. Init MongoDB
const Employee = require('./models/Employee');
const User = require('./models/User');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB...");

  // --- MIGRATE ADMIN ---
  const adminEmail = "dan@pvtchopra.com";
  const adminPass = "Anika@1212"; // Your current password

  console.log(`Migrating Admin: ${adminEmail}...`);
  
  let firebaseUser;
  try {
    firebaseUser = await admin.auth().getUserByEmail(adminEmail);
    console.log("Admin already exists in Firebase.");
  } catch (err) {
    firebaseUser = await admin.auth().createUser({
      email: adminEmail,
      password: adminPass,
      displayName: "Admin Dan"
    });
    console.log("Admin created in Firebase!");
  }

  // Update MongoDB with the UID
  await Employee.findOneAndUpdate(
    { email: adminEmail },
    { firebaseUid: firebaseUser.uid }
  );
  console.log("✅ Admin linked successfully!");

  console.log("\nMigration complete! You can now login with dan@pvtchopra.com using Firebase.");
  process.exit(0);
}

migrate().catch(err => {
  console.error("Migration Failed:", err);
  process.exit(1);
});
