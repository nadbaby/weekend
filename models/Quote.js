const mongoose = require("mongoose");

const QuoteSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: { type: String },
  company: { type: String },
  email: { type: String },
  phone: { type: String },
  product: { type: String },
  quantity: { type: String },
  message: { type: String },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model("Quote", QuoteSchema);
