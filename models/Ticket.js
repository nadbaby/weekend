const mongoose = require("mongoose");

const TicketSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  mobile: { type: String, required: true },
  userIdentifier: { type: String, required: true }, // email, username, or phone
  orderId: { type: String },
  productSku: { type: String },
  category: { type: String, required: true },
  priority: { type: String, default: "Low" },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  fileUrl: { type: String },
  status: { type: String, default: "Open" }, // Open, In Progress, Resolved, Closed
  assignedTo: { type: String },
  internalNotes: { type: String },
  replies: [
    {
      sender: { type: String, enum: ["Customer", "Admin"], default: "Customer" },
      senderName: { type: String },
      message: { type: String, required: true },
      fileUrl: { type: String },
      createdAt: { type: Date, default: Date.now }
    }
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Ticket", TicketSchema);
