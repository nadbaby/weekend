const mongoose = require("mongoose");

const ShippingConfigSchema = new mongoose.Schema({
  zones: {
    LOCAL_PUNJAB: {
      name: { type: String, default: "LOCAL/PUNJAB" },
      rates: {
        DOX_250G: { type: Number, default: 25 },
        PER_KG: { type: Number, default: 30 },
        PER_KG_HP: { type: Number, default: 55 },
        PARCEL_5KG_SURFACE: { type: Number, default: 30 }
      }
    },
    DELHI_NCR: {
      name: { type: String, default: "DELHI/NCR" },
      rates: {
        DOX_250G: { type: Number, default: 27 },
        PER_KG: { type: Number, default: 35 },
        PER_KG_HP: { type: Number, default: 35 },
        PARCEL_5KG_SURFACE: { type: Number, default: 35 }
      }
    },
    REST_OF_INDIA: {
      name: { type: String, default: "REST OF INDIA" },
      rates: {
        DOX_250G: { type: Number, default: 40 },
        PER_KG: { type: Number, default: 75 },
        PER_KG_HP: { type: Number, default: 75 },
        PARCEL_5KG_SURFACE: { type: Number, default: 55 }
      }
    },
    NORTH_EAST: {
      name: { type: String, default: "NORTH EAST" },
      rates: {
        DOX_250G: { type: Number, default: 40 },
        PER_KG: { type: Number, default: 95 },
        PER_KG_HP: { type: Number, default: 95 },
        PARCEL_5KG_SURFACE: { type: Number, default: 70 }
      }
    }
  },
  ncrCities: {
    type: [String],
    default: ["Delhi", "Noida", "Gurgaon", "Ghaziabad", "Faridabad", "Greater Noida"]
  },
  northEastStates: {
    type: [String],
    default: ["Arunachal Pradesh", "Assam", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Sikkim", "Tripura"]
  },
  punjabStates: {
    type: [String],
    default: ["Punjab", "Chandigarh"]
  },
  fuelSurcharge: { type: Number, default: 24 },
  gstRate: { type: Number, default: 18 },
  ewayBillCharge: { type: Number, default: 50 },
  invoiceValuePercent: { type: Number, default: 6 }, // 6-8% configurable
  minInvoiceValueForCharge: { type: Number, default: 50000 },
  fallbackDimensions: {
    length: { type: Number, default: 10 },
    width: { type: Number, default: 10 },
    height: { type: Number, default: 10 }
  },
  fallbackWeight: { type: Number, default: 0.5 },
  isShippingEnabled: {
    type: Boolean,
    default: true
  },

  // --- EXTENSIONS ---
  // Volumetric
  volumetricDivisor: { type: Number, default: 5000 },

  // Handling
  handlingCharge: { type: Number, default: 0 },
  handlingChargeType: { type: String, enum: ["FIXED", "PERCENTAGE"], default: "FIXED" },

  // COD Settings
  isCodFeeEnabled: { type: Boolean, default: true },
  codFee: { type: Number, default: 50 },
  codFeeType: { type: String, enum: ["FIXED", "PERCENTAGE"], default: "FIXED" },

  // Free shipping conditions
  isFreeShippingEnabled: { type: Boolean, default: false },
  freeShippingMinOrderValue: { type: Number, default: 5000 },
  freeShippingCategories: { type: [String], default: [] },

  // Courier Partners List
  couriers: {
    type: [
      {
        id: { type: String },
        name: { type: String },
        isActive: { type: Boolean, default: true },
        type: { type: String, enum: ["self", "aggregator"], default: "self" },
        baseRateAdjustment: { type: Number, default: 0 },
        rateMultiplier: { type: Number, default: 1.0 },
        apiSettings: {
          apiUrl: { type: String, default: "" },
          apiKey: { type: String, default: "" },
          apiSecret: { type: String, default: "" }
        }
      }
    ],
    default: [
      {
        id: "zedex",
        name: "ZEDEX Logistics",
        isActive: true,
        type: "self",
        baseRateAdjustment: 0,
        rateMultiplier: 1.0,
        apiSettings: { apiUrl: "", apiKey: "", apiSecret: "" }
      },
      {
        id: "shree_maruti",
        name: "Shree Maruti Courier",
        isActive: true,
        type: "self",
        baseRateAdjustment: 0,
        rateMultiplier: 1.0,
        apiSettings: { apiUrl: "", apiKey: "", apiSecret: "" }
      },
      {
        id: "shiprocket",
        name: "Shiprocket API",
        isActive: false,
        type: "aggregator",
        baseRateAdjustment: 20,
        rateMultiplier: 1.05,
        apiSettings: { apiUrl: "https://api.shiprocket.in/v1/external", apiKey: "", apiSecret: "" }
      },
      {
        id: "delhivery",
        name: "Delhivery Direct API",
        isActive: false,
        type: "aggregator",
        baseRateAdjustment: 30,
        rateMultiplier: 1.10,
        apiSettings: { apiUrl: "https://track.delhivery.com/api", apiKey: "", apiSecret: "" }
      },
      {
        id: "nimbuspost",
        name: "NimbusPost API",
        isActive: false,
        type: "aggregator",
        baseRateAdjustment: 15,
        rateMultiplier: 1.05,
        apiSettings: { apiUrl: "https://api.nimbuspost.com/v1", apiKey: "", apiSecret: "" }
      }
    ]
  },

  // Manual customized location based rules
  manualRules: {
    type: [
      {
        state: { type: String, default: "" },
        city: { type: String, default: "" },
        minOrderValue: { type: Number, default: 0 },
        shippingCharge: { type: Number, default: 0 },
        description: { type: String, default: "" }
      }
    ],
    default: []
  },

  // Customized Weight Slab multiplier adjustments
  weightSlabs: {
    type: [
      {
        minWeight: { type: Number, default: 0 },
        maxWeight: { type: Number, default: 9999 },
        rateMultiplier: { type: Number, default: 1.0 }
      }
    ],
    default: []
  }
}, { timestamps: true });

module.exports = mongoose.model("ShippingConfig", ShippingConfigSchema);
