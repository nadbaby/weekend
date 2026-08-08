const mongoose = require("mongoose");

const PromotionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  message: { type: String, required: true },
  channels: [{ type: String }],
  sentBy: { type: String, required: true },
  recipients: [
    {
      userId: { type: String },
      name: { type: String },
      phone: { type: String },
      status: { type: String },
      error: { type: String }
    }
  ],
  sentAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Promotion", PromotionSchema);