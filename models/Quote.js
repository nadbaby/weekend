const mongoose = require("mongoose");

const QuoteSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: { type: String },
  company: { type: String },
  email: { type: String },
  phone: { type: String },
  product: { type: String },    // Fallback for old single-product forms
  quantity: { type: String },   // Fallback for old single-product forms
  message: { type: String },    // Fallback message
  userId: { type: String },     // Username or phone of requester

  // NEW RFQ FIELDS FOR B2B NEGOTIATIONS
  items: [{
    productId: { type: Number },
    name: { type: String },
    image: { type: String },
    quantity: { type: Number },
    originalPrice: { type: Number },
    offeredPrice: { type: Number }, // Price offered by admin
    counterPrice: { type: Number }, // Counter price suggested by customer
  }],
  status: { 
    type: String, 
    enum: ["Pending Review", "Price Offered", "Counter Offered", "Accepted", "Converted to Order", "Rejected"],
    default: "Pending Review"
  },
  negotiationHistory: [{
    sender: { type: String }, // "customer" or "admin"
    senderName: { type: String },
    message: { type: String },
    createdAt: { type: Date, default: Date.now }
  }],
  totalOriginalAmount: { type: Number },
  totalOfferedAmount: { type: Number },
  totalCounterAmount: { type: Number },
  orderId: { type: String },
  createdAt: { type: String, default: () => new Date().toISOString() },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Quote", QuoteSchema);
