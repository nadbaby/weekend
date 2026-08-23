const fs = require("fs");
const path = require("path");
require('dotenv').config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

// Models
const User = require("../models/User");
const Employee = require("../models/Employee");
const Order = require("../models/Order");
const Quote = require("../models/Quote");

const migrateData = async () => {
  try {
    await connectDB();
    console.log("Connected to MongoDB for migration...");

    const filesToMigrate = [
      { name: "users.json", model: User, key: "id" },
      { name: "employees.json", model: Employee, key: "username" },
      { name: "orders.json", model: Order, key: "orderId" },
      { name: "quotes.json", model: Quote, key: "id" }
    ];

    for (const fileInfo of filesToMigrate) {
      const filePath = path.join(__dirname, "..", fileInfo.name);
      
      if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${fileInfo.name} (file not found)`);
        continue;
      }

      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      console.log(`Migrating ${data.length} records from ${fileInfo.name}...`);

      for (const item of data) {
        // Upsert to avoid duplicates if script is run multiple times
        const filter = {};
        filter[fileInfo.key] = item[fileInfo.key];
        
        await fileInfo.model.findOneAndUpdate(filter, item, { upsert: true, new: true });
      }
      console.log(`Finished migrating ${fileInfo.name}`);
    }

    console.log("All data migration completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
};

migrateData();
