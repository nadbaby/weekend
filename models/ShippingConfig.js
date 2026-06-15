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
  }
}, { timestamps: true });

module.exports = mongoose.model("ShippingConfig", ShippingConfigSchema);
