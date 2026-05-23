/**
 * Migration Script: Import existing products from JSON to MongoDB
 * 
 * Usage: node scripts/migrate-products.js
 * 
 * This will read products_corrected.json and insert them into MongoDB.
 * Existing local image paths will be preserved as-is (they still work
 * until you re-upload them via the admin panel to move them to Cloudinary).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const fs = require("fs");
const Product = require("../models/Product");
const connectDB = require("../config/db");

const migrate = async () => {
  await connectDB();

  const jsonPath = path.join(__dirname, "..", "products_corrected.json");

  if (!fs.existsSync(jsonPath)) {
    console.error("❌ products_corrected.json not found!");
    process.exit(1);
  }

  const rawProducts = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  console.log(`📦 Found ${rawProducts.length} products in JSON file`);

  let imported = 0;
  let skipped = 0;

  for (const p of rawProducts) {
    // Check if already exists
    const exists = await Product.findOne({ id: p.id });
    if (exists) {
      console.log(`⏭️  Skipping product ID ${p.id} (${p.name}) — already exists`);
      skipped++;
      continue;
    }

    // Convert images array from plain strings to {url, publicId} objects
    const images = (p.images || []).map((imgUrl) => ({
      url: imgUrl,
      publicId: "", // No Cloudinary ID for legacy images
    }));

    // Convert specifications object to Map-compatible format
    const specifications = p.specifications || {};

    const product = new Product({
      id: p.id,
      sku: p.sku || "",
      name: p.name,
      slug: p.slug || "",
      brand: p.brand || "",
      category: p.category || "",
      subcategory: p.subcategory || "",
      price: p.price || 0,
      stock: p.stock || null,
      description: p.description || "",
      image: p.image || "",
      imagePublicId: "",
      catalogue: p.catalogue || "",
      cataloguePublicId: "",
      images,
      features: p.features || [],
      specifications,
      isActive: p.isActive !== false,
      keywords: p.keywords || "",
      primaryKey: p.primaryKey || "",
      secondaryKey: p.secondaryKey || "",
      hsnCode: p.hsnCode || "",
    });

    await product.save();
    console.log(`✅ Imported: ${p.name} (ID: ${p.id})`);
    imported++;
  }

  console.log(`\n🎉 Migration complete! Imported: ${imported}, Skipped: ${skipped}`);
  process.exit(0);
};

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
