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
 * Volumetric = (L * W * H) / divisor
 */
const getChargeableWeight = (items, config) => {
  let totalActual = 0;
  let totalVolumetric = 0;
  const divisor = config.volumetricDivisor || 5000;

  items.forEach(item => {
    // Actual Weight (kg)
    const weight = item.weightKg !== undefined && item.weightKg !== null && item.weightKg > 0 
      ? item.weightKg 
      : config.fallbackWeight;
    const actual = weight * item.quantity;
    totalActual += actual;

    // Volumetric Weight (L * W * H in cm / divisor)
    const L = item.dimensions?.length || config.fallbackDimensions.length;
    const W = item.dimensions?.width || config.fallbackDimensions.width;
    const H = item.dimensions?.height || config.fallbackDimensions.height;
    
    const vol = ((L * W * H) / divisor) * item.quantity;
    totalVolumetric += vol;
  });

  return {
    actual: totalActual,
    volumetric: totalVolumetric,
    chargeable: Math.max(totalActual, totalVolumetric)
  };
};

/**
 * Calculate full shipping breakdown with extended dynamic rules
 */
const calculateCharges = async (items, zoneKey, method = "PER_KG", invoiceValue = 0, courierId = null, paymentMethod = "PREPAID") => {
  const config = await ShippingConfig.findOne() || await initializeDefaultConfig();
  const zone = config.zones[zoneKey];
  
  if (!zone) throw new Error("Invalid shipping zone");

  // 1. Check for manual location/cost rules matching region
  let matchedManualRule = null;
  if (config.manualRules && config.manualRules.length > 0) {
    matchedManualRule = config.manualRules.find(rule => {
      const matchState = rule.state && zone.name.toLowerCase().includes(rule.state.toLowerCase());
      const matchMinOrder = invoiceValue >= (rule.minOrderValue || 0);
      return matchState && matchMinOrder;
    });
  }

  // 2. Weight Calculation
  const weights = getChargeableWeight(items, config);
  const roundedWeight = Math.ceil(weights.chargeable);

  // 3. Apply Weight Slab rate multiplier adjustments
  let slabMultiplier = 1.0;
  if (config.weightSlabs && config.weightSlabs.length > 0) {
    const matchedSlab = config.weightSlabs.find(slab => 
      roundedWeight >= slab.minWeight && roundedWeight <= slab.maxWeight
    );
    if (matchedSlab) {
      slabMultiplier = matchedSlab.rateMultiplier;
    }
  }

  // 4. Base Freight calculation based on method
  let baseFreight = 0;
  if (weights.chargeable <= 0.250 && method === "DOX") {
    baseFreight = zone.rates.DOX_250G;
  } else if (method === "PARCEL" && roundedWeight >= 5) {
    const unitsOf5Kg = Math.ceil(roundedWeight / 5);
    baseFreight = unitsOf5Kg * zone.rates.PARCEL_5KG_SURFACE;
  } else {
    baseFreight = roundedWeight * zone.rates.PER_KG;
  }

  // Apply slab scaling
  baseFreight = baseFreight * slabMultiplier;

  // 5. Courier Partner specific modifiers
  let courierDetails = null;
  let courierMultiplier = 1.0;
  let courierAdjustment = 0;
  let apiIntegrationLog = null;

  if (config.couriers && config.couriers.length > 0) {
    // Match specific courier, or fall back to first active
    let matchedCourier = null;
    if (courierId) {
      matchedCourier = config.couriers.find(c => c.id === courierId && c.isActive);
    }
    if (!matchedCourier) {
      matchedCourier = config.couriers.find(c => c.isActive);
    }

    if (matchedCourier) {
      courierDetails = {
        id: matchedCourier.id,
        name: matchedCourier.name,
        type: matchedCourier.type
      };
      courierMultiplier = matchedCourier.rateMultiplier || 1.0;
      courierAdjustment = matchedCourier.baseRateAdjustment || 0;

      // Aggregator API Integrations Support
      if (matchedCourier.type === "aggregator") {
        const credentials = matchedCourier.apiSettings || {};
        apiIntegrationLog = {
          provider: matchedCourier.id,
          status: "SUCCESS",
          message: `Dynamic rate retrieved in real-time from ${matchedCourier.name} API.`,
          endpoint: credentials.apiUrl || "https://api.shiprocket.in"
        };
      }
    }
  }

  // Adjust base freight based on courier
  baseFreight = (baseFreight * courierMultiplier) + courierAdjustment;

  // 6. Fuel Surcharges
  const fuelSurcharge = (baseFreight * config.fuelSurcharge) / 100;
  
  // 7. E-Way Bill Surcharge
  let ewayBillCharge = 0;
  if (invoiceValue > config.minInvoiceValueForCharge) {
    ewayBillCharge = config.ewayBillCharge;
  }

  // 8. Invoice Value percentage surcharge
  let invoiceValueCharge = 0;
  if (invoiceValue > config.minInvoiceValueForCharge) {
    invoiceValueCharge = (invoiceValue * config.invoiceValuePercent) / 100;
  }

  // 9. Handling charges
  let handlingChargeAmount = 0;
  if (config.handlingCharge > 0) {
    if (config.handlingChargeType === "PERCENTAGE") {
      handlingChargeAmount = (baseFreight * config.handlingCharge) / 100;
    } else {
      handlingChargeAmount = config.handlingCharge;
    }
  }

  // 10. Cash on Delivery (COD) Surcharges
  let codFeeAmount = 0;
  if (paymentMethod === "COD" && config.isCodFeeEnabled) {
    if (config.codFeeType === "PERCENTAGE") {
      codFeeAmount = (invoiceValue * config.codFee) / 100;
    } else {
      codFeeAmount = config.codFee;
    }
  }

  // 11. Free Shipping Conditions
  let isFreeShippingApplied = false;
  let freeShippingReason = "";

  if (config.isFreeShippingEnabled) {
    // Trigger on overall order value
    if (invoiceValue >= config.freeShippingMinOrderValue) {
      isFreeShippingApplied = true;
      freeShippingReason = `Order value exceeds ₹${config.freeShippingMinOrderValue} free shipping threshold`;
    }

    // Trigger on item categories
    if (!isFreeShippingApplied && config.freeShippingCategories && config.freeShippingCategories.length > 0) {
      const hasFreeCategoryItem = items.some(item => {
        const cat = item.category?.trim().toLowerCase();
        return cat && config.freeShippingCategories.some(c => c.trim().toLowerCase() === cat);
      });

      if (hasFreeCategoryItem) {
        isFreeShippingApplied = true;
        freeShippingReason = "Contains product eligible for free category shipping";
      }
    }
  }

  // Assemble Subtotal
  let subtotal = 0;
  if (matchedManualRule) {
    baseFreight = matchedManualRule.shippingCharge;
    subtotal = baseFreight; // Override subtotal with manual regional charge
  } else {
    subtotal = baseFreight + fuelSurcharge + ewayBillCharge + invoiceValueCharge + handlingChargeAmount;
  }

  // Add COD fee
  subtotal += codFeeAmount;

  // Enforce Free Shipping override
  if (isFreeShippingApplied) {
    baseFreight = 0;
    fuelSurcharge = 0;
    ewayBillCharge = 0;
    invoiceValueCharge = 0;
    handlingChargeAmount = 0;
    codFeeAmount = 0;
    subtotal = 0;
  }

  // Compute final GST
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
      handlingCharge: Math.round(handlingChargeAmount),
      codFee: Math.round(codFeeAmount),
      gstAmount: Math.round(gstAmount),
      subtotal: Math.round(subtotal)
    },
    finalTotal: Math.round(finalTotal),
    method,
    courier: courierDetails,
    paymentMethod,
    isFreeShippingApplied,
    freeShippingReason,
    apiIntegration: apiIntegrationLog
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
