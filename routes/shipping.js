const express = require("express");
const router = express.Router();
const ShippingConfig = require("../models/ShippingConfig");
const { detectZone, calculateCharges } = require("../services/shippingService");
const Product = require("../models/Product");

/**
 * @route POST /api/shipping/calculate
 * @desc Calculate shipping charges for a cart and address
 */
router.post("/calculate", async (req, res) => {
  try {
    const { items, address, method = "PER_KG" } = req.body;

    if (!items || !address) {
      return res.status(400).json({ message: "Items and address are required" });
    }

    // 1. Calculate total weight from product data
    let totalWeight = 0;
    for (const item of items) {
      const product = await Product.findOne({ id: item.id });
      const weight = product?.weightKg || 0.5; // Default 0.5kg if not specified
      totalWeight += weight * (item.quantity || 1);
    }

    // 2. Detect Zone
    const zoneKey = await detectZone(address.city, address.state);

    // 3. Calculate Charges
    const calculation = await calculateCharges(totalWeight, zoneKey, method);

    res.json({
      success: true,
      data: {
        ...calculation,
        totalWeight,
        address: {
          city: address.city,
          state: address.state
        }
      }
    });
  } catch (error) {
    console.error("Shipping Calculation Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route GET /api/shipping/config
 * @desc Get current shipping configurations (Admin)
 */
router.get("/config", async (req, res) => {
  try {
    let config = await ShippingConfig.findOne();
    if (!config) {
      config = new ShippingConfig();
      await config.save();
    }
    res.json({ success: true, data: config });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route PUT /api/shipping/config
 * @desc Update shipping configurations (Admin)
 */
router.put("/config", async (req, res) => {
  try {
    const updatedConfig = await ShippingConfig.findOneAndUpdate(
      {},
      { $set: req.body },
      { new: true, upsert: true }
    );
    res.json({ success: true, data: updatedConfig, message: "Shipping settings updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route GET /api/shipping/analytics
 * @desc Basic shipping revenue analytics (Admin)
 */
router.get("/analytics", async (req, res) => {
    try {
        const Order = require("../models/Order");
        const stats = await Order.aggregate([
            { $match: { status: "PAID" } },
            { $group: {
                _id: "$shippingDetails.zone",
                totalRevenue: { $sum: "$shippingCharge" },
                orderCount: { $sum: 1 },
                avgWeight: { $avg: "$shippingDetails.totalWeight" }
            }}
        ]);
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
