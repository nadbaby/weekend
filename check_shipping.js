require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const mongoose = require('mongoose');
const Product = require('./models/Product');

async function check() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const products = await Product.find().limit(10);
        console.log("=== PRODUCTS ===");
        products.forEach(p => {
            console.log(`Product: ${p.name}, weightKg: ${p.weightKg}, dimensions: ${JSON.stringify(p.dimensions)}`);
        });
        
    } catch (err) {
        console.error(err);
    } finally {
        mongoose.connection.close();
        process.exit(0);
    }
}
check();
