const mongoose = require("mongoose");

const EmployeeSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  name: { type: String },
  email: { type: String },
  role: { type: String, default: "Employee" },
  permissions: { type: [String], default: [] },
  phone: { type: String },
  gstNumber: { type: String },
  firebaseUid: { type: String, unique: true, sparse: true },
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model("Employee", EmployeeSchema);
