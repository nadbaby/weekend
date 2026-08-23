const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    // Keep numeric `id` for backward compatibility with frontend
    id: {
      type: Number,
      unique: true,
      index: true,
    },
    sku: {
      type: String,
      default: "",
    },
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
    },
    slug: {
      type: String,
      default: "",
      trim: true,
    },
    brand: {
      type: String,
      default: "",
    },
    category: {
      type: String,
      default: "",
    },
    subcategory: {
      type: String,
      default: "",
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: 0,
    },
    stock: {
      type: Number,
      default: null,
    },
    description: {
      type: String,
      default: "",
    },
    // Main image — now a full Cloudinary URL
    image: {
      type: String,
      default: "",
    },
    // Cloudinary public_id for the main image (for deletion)
    imagePublicId: {
      type: String,
      default: "",
    },
    // Catalogue file URL (Cloudinary)
    catalogue: {
      type: String,
      default: "",
    },
    cataloguePublicId: {
      type: String,
      default: "",
    },
    // Additional images array
    images: [
      {
        url: { type: String, default: "" },
        publicId: { type: String, default: "" },
      },
    ],
    features: [String],
    specifications: {
      type: Map,
      of: String,
      default: {},
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    keywords: {
      type: String,
      default: "",
    },
    primaryKey: {
      type: String,
      default: "",
    },
    secondaryKey: {
      type: String,
      default: "",
    },
    hsnCode: {
      type: String,
      default: "",
    },
    weightKg: {
      type: Number,
      default: 0,
      min: 0,
    },
    dimensions: {
      length: { type: Number, default: 0 },
      width: { type: Number, default: 0 },
      height: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
    // Transform output to match existing frontend expectations
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        // Convert images array from [{url, publicId}] to plain string array
        // so frontend receives the same format it currently expects
        if (ret.images && Array.isArray(ret.images)) {
          ret.images = ret.images.map((img) =>
            typeof img === "string" ? img : img.url
          );
        }
        // Convert Map to plain object for specifications
        if (ret.specifications instanceof Map) {
          ret.specifications = Object.fromEntries(ret.specifications);
        }
        // Remove Mongoose internals
        delete ret._id;
        delete ret.__v;
        delete ret.imagePublicId;
        delete ret.cataloguePublicId;
        return ret;
      },
    },
  }
);

// Add Compound Indexes for typical dashboard / storefront filters
productSchema.index({ isActive: 1, category: 1, subcategory: 1 });
productSchema.index({ isActive: 1, brand: 1 });
productSchema.index({ price: 1, id: 1 }); // Sort optimization

// Replace slow full-table scan regex with high-performance Full Text Index
productSchema.index({
  sku: 'text',
  name: 'text',
  keywords: 'text',
  description: 'text'
}, {
  weights: {
    sku: 10,
    name: 8,
    keywords: 5,
    description: 1
  },
  name: "Product_Text_Search_Index"
});

// Auto-generate numeric `id` if not provided
productSchema.pre("save", async function () {
  if (!this.id) {
    const lastProduct = await this.constructor.findOne().sort({ id: -1 });
    this.id = lastProduct ? lastProduct.id + 1 : 1;
  }
});

module.exports = mongoose.model("Product", productSchema);
