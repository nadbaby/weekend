
require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const mongoose = require('mongoose');
const Order = require('./models/Order');

async function check() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const count = await Order.countDocuments({ "paymentDetails.status": "SUCCESS" });
        const allCount = await Order.countDocuments({});
        console.log(`Successful Orders: ${count}`);
        console.log(`Total Orders: ${allCount}`);
        process.exit(0);
    } catch (error) {
        console.error("Error checking orders:", error);
        process.exit(1);
    }
}8.
check();
