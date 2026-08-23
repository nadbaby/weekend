const express = require("express");
const router = express.Router();
const User = require("../models/User");

// --- Helper: Secure Error Response ---
const sendErrorResponse = (res, error, defaultMessage = "An internal server error occurred") => {
  console.error("User Route Error:", error);
  const isProd = process.env.NODE_ENV === "production";
  res.status(500).json({
    success: false,
    message: isProd ? defaultMessage : (error.message || defaultMessage)
  });
};

// --- Middleware: Validate and Bind User ID ---
router.use((req, res, next) => {
  const userId = req.user?.uid || req.user?.username;
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized: Invalid user session" });
  }
  req.userId = userId;
  next();
});

// --- Cart Routes ---

/**
 * @route GET /api/user/cart
 * @desc Get user's saved cart
 */
router.get("/cart", async (req, res) => {
  try {
    const user = await User.findOne({ 
      $or: [{ firebaseUid: req.userId }, { username: req.userId }, { phone: req.userId }] 
    });

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, cart: user.cart || [] });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to retrieve cart");
  }
});

/**
 * @route POST /api/user/cart
 * @desc Sync/Update user's cart
 */
router.post("/cart", async (req, res) => {
  try {
    const { cart } = req.body;

    const user = await User.findOneAndUpdate(
      { $or: [{ firebaseUid: req.userId }, { username: req.userId }, { phone: req.userId }] },
      { $set: { cart } },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, message: "Cart synced successfully", cart: user.cart });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to sync cart");
  }
});

// --- Address Routes ---

/**
 * @route GET /api/user/addresses
 * @desc Get user's saved addresses
 */
router.get("/addresses", async (req, res) => {
  try {
    const user = await User.findOne({ 
      $or: [{ firebaseUid: req.userId }, { username: req.userId }, { phone: req.userId }] 
    });

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, addresses: user.addresses || [] });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to retrieve addresses");
  }
});

/**
 * @route POST /api/user/addresses
 * @desc Add a new saved address
 */
router.post("/addresses", async (req, res) => {
  try {
    const addressData = req.body;

    const user = await User.findOne({ 
      $or: [{ firebaseUid: req.userId }, { username: req.userId }, { phone: req.userId }] 
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    // If this is the first address, make it default
    if (user.addresses.length === 0) {
      addressData.isDefault = true;
    } else if (addressData.isDefault) {
      // If setting this as default, unset others
      user.addresses.forEach(addr => addr.isDefault = false);
    }

    user.addresses.push(addressData);
    await user.save();

    res.json({ success: true, message: "Address saved successfully", addresses: user.addresses });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to save address");
  }
});

/**
 * @route DELETE /api/user/addresses/:addressId
 * @desc Delete a saved address
 */
router.delete("/addresses/:addressId", async (req, res) => {
  try {
    const { addressId } = req.params;

    const user = await User.findOneAndUpdate(
      { $or: [{ firebaseUid: req.userId }, { username: req.userId }, { phone: req.userId }] },
      { $pull: { addresses: { id: addressId } } },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, message: "Address deleted", addresses: user.addresses });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to delete address");
  }
});

/**
 * @route PATCH /api/user/addresses/:addressId/default
 * @desc Set an address as default
 */
router.patch("/addresses/:addressId/default", async (req, res) => {
  try {
    const { addressId } = req.params;

    const user = await User.findOne({ 
      $or: [{ firebaseUid: req.userId }, { username: req.userId }, { phone: req.userId }] 
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    user.addresses.forEach(addr => {
      addr.isDefault = (addr.id === addressId);
    });

    await user.save();
    res.json({ success: true, message: "Default address updated", addresses: user.addresses });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update default address");
  }
});

/**
 * @route POST /api/user/update-profile
 * @desc Update user profile details
 */
router.post("/update-profile", async (req, res) => {
  try {
    const { name, email, company, gstNumber, profilePic } = req.body;

    const updateData = {
      name,
      email,
      company,
      gstNumber,
      profilePic
    };

    // Remove undefined fields
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    const user = await User.findOneAndUpdate(
      { $or: [{ firebaseUid: req.userId }, { username: req.userId }, { phone: req.userId }] },
      { $set: updateData },
      { new: true }
    ).lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ success: true, message: "Profile updated successfully", user });
  } catch (error) {
    sendErrorResponse(res, error, "Failed to update profile");
  }
});

module.exports = router;
