const express = require("express");
const router = express.Router();
const ShippingConfig = require("../models/ShippingConfig");
const { detectZone, calculateCharges } = require("../services/shippingService");
const Product = require("../models/Product");

// --- Helper: Secure Error Response ---
const sendErrorResponse = (res, error, defaultMessage = "An internal server error occurred") => {
  console.error("Shipping Route Error:", error);
  const isProd = process.env.NODE_ENV === "production";
  res.status(500).json({
    success: false,
    message: isProd ? defaultMessage : (error.message || defaultMessage)
  });
};

/**
 * @route POST /api/shipping/calculate
 * @desc Calculate shipping charges for a cart and address
 */
router.post("/calculate", async (req, res) => {
  try {
    const { items, address, method = "PER_KG", courierId = null, paymentMethod = "PREPAID" } = req.body;

    if (!items || !address) {
      return res.status(400).json({ message: "Items and address are required" });
    }

    // 1. Build items list with actual DB weights and dimensions
    const itemsForShipping = [];
    let totalWeight = 0;
    for (const item of items) {
      const product = await Product.findOne({ id: item.id });
      const weight = product?.weightKg || 0.5;
      totalWeight += weight * (item.quantity || 1);
      
      itemsForShipping.push({
        id: item.id,
        quantity: item.quantity || 1,
        weightKg: weight,
        dimensions: product?.dimensions,
        category: product?.category
      });
    }

    // 2. Detect Zone
    const zoneKey = await detectZone(address.city, address.state);

    // 3. Calculate Charges
    const calculation = await calculateCharges(itemsForShipping, zoneKey, method, 0, courierId, paymentMethod);

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
    sendErrorResponse(res, error, "Failed to calculate shipping charges");
  }
});

router.post("/preview", async (req, res) => {
  try {
    const { items, state, city, method = "PER_KG", invoiceValue = 0, courierId = null, paymentMethod = "PREPAID" } = req.body;
    
    if (!items || !items.length) {
      return res.status(400).json({ message: "Items are required" });
    }

    const zoneKey = await detectZone(city, state);
    const result = await calculateCharges(items, zoneKey, method, invoiceValue, courierId, paymentMethod);
    
    res.json(result);
  } catch (error) {
    sendErrorResponse(res, error, "Failed to fetch shipping preview");
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
    sendErrorResponse(res, error, "Failed to retrieve shipping configuration");
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
    sendErrorResponse(res, error, "Failed to update shipping configuration");
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
        sendErrorResponse(res, error, "Failed to retrieve shipping analytics");
    }
});

module.exports = router;
