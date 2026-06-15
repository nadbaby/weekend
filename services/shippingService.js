const ShippingConfig = require("../models/ShippingConfig");

/**
 * Detect shipping zone based on city and state
 */
const detectZone = async (city, state) => {
  const config = await ShippingConfig.findOne() || await initializeDefaultConfig();
  
  const normalizedCity = city?.trim().toLowerCase();
  const normalizedState = state?.trim().toLowerCase();

  // 1. Check LOCAL/PUNJAB
  if (config.punjabStates.some(s => s.toLowerCase() === normalizedState)) {
    return "LOCAL_PUNJAB";
  }

  // 2. Check DELHI/NCR
  if (
    normalizedState === "delhi" || 
    config.ncrCities.some(c => c.toLowerCase() === normalizedCity)
  ) {
    return "DELHI_NCR";
  }

  // 3. Check NORTH EAST
  if (config.northEastStates.some(s => s.toLowerCase() === normalizedState)) {
    return "NORTH_EAST";
  }

  // 4. Default to REST OF INDIA
  return "REST_OF_INDIA";
};

/**
 * Calculate Chargeable Weight (Max of Actual vs Volumetric)
 * Volumetric = (L * W * H) / 5000
 */
const getChargeableWeight = (items, config) => {
  let totalActual = 0;
  let totalVolumetric = 0;

  items.forEach(item => {
    // Actual Weight
    const actual = (item.weightKg || config.fallbackWeight) * item.quantity;
    totalActual += actual;

    // Volumetric Weight
    const L = item.dimensions?.length || config.fallbackDimensions.length;
    const W = item.dimensions?.width || config.fallbackDimensions.width;
    const H = item.dimensions?.height || config.fallbackDimensions.height;
    
    const vol = ((L * W * H) / 5000) * item.quantity;
    totalVolumetric += vol;
  });

  return {
    actual: totalActual,
    volumetric: totalVolumetric,
    chargeable: Math.max(totalActual, totalVolumetric)
  };
};

/**
 * Calculate full shipping breakdown
 */
const calculateCharges = async (items, zoneKey, method = "PER_KG", invoiceValue = 0) => {
  const config = await ShippingConfig.findOne() || await initializeDefaultConfig();
  const zone = config.zones[zoneKey];
  
  if (!zone) throw new Error("Invalid shipping zone");

  // 1. Weight Calculation
  const weights = getChargeableWeight(items, config);
  const roundedWeight = Math.ceil(weights.chargeable);

  // 2. Base Freight calculation based on method
  let baseFreight = 0;
  if (weights.chargeable <= 0.250 && method === "DOX") {
    baseFreight = zone.rates.DOX_250G;
  } else if (method === "PARCEL" && roundedWeight >= 5) {
    const unitsOf5Kg = Math.ceil(roundedWeight / 5);
    baseFreight = unitsOf5Kg * zone.rates.PARCEL_5KG_SURFACE;
  } else {
    baseFreight = roundedWeight * zone.rates.PER_KG;
  }

  // 3. Surcharges
  const fuelSurcharge = (baseFreight * config.fuelSurcharge) / 100;
  
  let ewayBillCharge = 0;
  if (invoiceValue > config.minInvoiceValueForCharge) {
    ewayBillCharge = config.ewayBillCharge;
  }

  let invoiceValueCharge = 0;
  if (invoiceValue > 0) {
    invoiceValueCharge = (invoiceValue * config.invoiceValuePercent) / 100;
  }

  // 4. GST (18% on Subtotal of all charges)
  const subtotal = baseFreight + fuelSurcharge + ewayBillCharge + invoiceValueCharge;
  const gstAmount = (subtotal * config.gstRate) / 100;
  const finalTotal = subtotal + gstAmount;

  return {
    zoneName: zone.name,
    weights,
    breakdown: {
      baseFreight: Math.round(baseFreight),
      fuelSurcharge: Math.round(fuelSurcharge),
      ewayBillCharge: Math.round(ewayBillCharge),
      invoiceValueCharge: Math.round(invoiceValueCharge),
      gstAmount: Math.round(gstAmount),
      subtotal: Math.round(subtotal)
    },
    finalTotal: Math.round(finalTotal),
    method
  };
};

/**
 * Initialize default config if not exists
 */
const initializeDefaultConfig = async () => {
  const existing = await ShippingConfig.findOne();
  if (existing) return existing;

  const defaultConfig = new ShippingConfig();
  return await defaultConfig.save();
};

module.exports = {
  detectZone,
  getChargeableWeight,
  calculateCharges,
  initializeDefaultConfig
};
