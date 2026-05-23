
const mongoose = require('mongoose');
require('dotenv').config();
const Product = require('./models/Product');

async function check() {
    await mongoose.connect(process.env.MONGODB_URI);
    const products = await Product.find({}).limit(5);
    console.log(JSON.stringify(products.map(p => ({ id: p.id, image: p.image })), null, 2));
    process.exit(0);
}
check();
