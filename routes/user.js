const express = require("express");
const router = express.Router();
const User = require("../models/User");

// --- Cart Routes ---

/**
 * @route GET /api/user/cart
 * @desc Get user's saved cart
 */
router.get("/cart", async (req, res) => {
  try {
    const userId = req.user.uid || req.user.username;
    const user = await User.findOne({ 
      $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }] 
    });

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, cart: user.cart || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route POST /api/user/cart
 * @desc Sync/Update user's cart
 */
router.post("/cart", async (req, res) => {
  try {
    const { cart } = req.body;
    const userId = req.user.uid || req.user.username;

    const user = await User.findOneAndUpdate(
      { $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }] },
      { $set: { cart } },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, message: "Cart synced successfully", cart: user.cart });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- Address Routes ---

/**
 * @route GET /api/user/addresses
 * @desc Get user's saved addresses
 */
router.get("/addresses", async (req, res) => {
  try {
    const userId = req.user.uid || req.user.username;
    const user = await User.findOne({ 
      $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }] 
    });

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, addresses: user.addresses || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route POST /api/user/addresses
 * @desc Add a new saved address
 */
router.post("/addresses", async (req, res) => {
  try {
    const addressData = req.body;
    const userId = req.user.uid || req.user.username;

    const user = await User.findOne({ 
      $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }] 
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
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route DELETE /api/user/addresses/:addressId
 * @desc Delete a saved address
 */
router.delete("/addresses/:addressId", async (req, res) => {
  try {
    const { addressId } = req.params;
    const userId = req.user.uid || req.user.username;

    const user = await User.findOneAndUpdate(
      { $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }] },
      { $pull: { addresses: { id: addressId } } },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ success: true, message: "Address deleted", addresses: user.addresses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route PATCH /api/user/addresses/:addressId/default
 * @desc Set an address as default
 */
router.patch("/addresses/:addressId/default", async (req, res) => {
  try {
    const { addressId } = req.params;
    const userId = req.user.uid || req.user.username;

    const user = await User.findOne({ 
      $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }] 
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    user.addresses.forEach(addr => {
      addr.isDefault = (addr.id === addressId);
    });

    await user.save();
    res.json({ success: true, message: "Default address updated", addresses: user.addresses });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route POST /api/user/update-profile
 * @desc Update user profile details
 */
router.post("/update-profile", async (req, res) => {
  try {
    const { name, email, company, gstNumber, profilePic } = req.body;
    const userId = req.user.uid || req.user.username;

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
      { $or: [{ firebaseUid: userId }, { username: userId }, { phone: userId }] },
      { $set: updateData },
      { new: true }
    ).lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ success: true, message: "Profile updated successfully", user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
