const mongoose = require('mongoose');
require('dotenv').config();
const Quote = require('./models/Quote');
const Order = require('./models/Order');

async function inspect() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to DB");
  const quotes = await Quote.find({}).sort({ updatedAt: -1 }).limit(3);
  console.log("QUOTES:", JSON.stringify(quotes, null, 2));
  
  const orders = await Order.find({}).sort({ createdAt: -1 }).limit(3);
  console.log("ORDERS:", JSON.stringify(orders, null, 2));

  await mongoose.disconnect();
}

inspect().catch(console.error);
