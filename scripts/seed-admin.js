const mongoose = require("mongoose");
require("dotenv").config();
const Employee = require("../models/Employee");
const connectDB = require("../config/db");

const seedAdmin = async () => {
  try {
    await connectDB();

    const adminUsername = (process.env.ADMIN_USERNAME || "admin").trim();
    const adminPassword = (process.env.ADMIN_PASSWORD || "admin").trim();

    const adminData = {
      username: adminUsername,
      password: adminPassword,
      name: "Main Administrator",
      email: adminUsername,
      role: "admin",
      permissions: ["all"]
    };

    let admin = await Employee.findOne({ username: new RegExp(`^${adminUsername}$`, 'i') });
    
    if (admin) {
      Object.assign(admin, adminData);
    } else {
      adminData.id = "ADM" + Date.now();
      admin = new Employee(adminData);
    }

    await admin.save();

    console.log(`✅ Admin ${adminUsername} seeded/updated successfully!`);
    process.exit(0);
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  }
};

seedAdmin();
