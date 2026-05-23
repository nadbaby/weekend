const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  phone: { type: String, unique: true, sparse: true },
  username: { type: String, unique: true, sparse: true },
  name: { type: String },
  email: { type: String },
  password: { type: String },
  company: { type: String },
  role: { type: String, default: "user" },
  specialDiscount: { type: Number, default: 0 },
  gstNumber: { type: String },
  profilePic: { type: String },
  firebaseUid: { type: String, unique: true, sparse: true },
  addresses: [{
    id: { type: String, default: () => `addr_${Date.now()}_${Math.floor(Math.random() * 1000)}` },
    fullName: String,
    phone: String,
    email: String,
    company: String,
    street: String,
    city: String,
    state: String,
    zip: String,
    country: { type: String, default: "India" },
    landmark: String,
    nearbyPlaces: String,
    gstNumber: String,
    deliveryInstructions: String,
    lat: Number,
    lng: Number,
    isDefault: { type: Boolean, default: false }
  }],
  cart: [{
    id: Number,
    name: String,
    price: Number,
    quantity: Number,
    image: String,
    addedAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: String, default: () => new Date().toISOString() }
});

module.exports = mongoose.model("User", UserSchema);
