const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");
const Order = require("../models/Order");
const { v4: uuidv4 } = require("uuid"); // to auto-generate unique ID if missing

// --- Helper: Secure Error Response ---
const sendErrorResponse = (res, error, defaultMessage = "An internal server error occurred") => {
    console.error("Admin Route Error:", error);
    const isProd = process.env.NODE_ENV === "production";
    res.status(500).json({
        success: false,
        message: isProd ? defaultMessage : (error.message || defaultMessage)
    });
};

// Assuming auth middleware protects /api/admin globally in server.js
// If not, we can assume token validation happens at the proxy or middleware layer before reaching here

/**
 * @route GET /api/admin/employees
 * @desc Get all registered employees
 */
router.get("/employees", async (req, res) => {
    try {
        const employees = await Employee.find({}).lean();
        const safeEmployees = employees.map(emp => {
            const e = { ...emp };
            if (e.email && typeof e.email === 'object') {
                e.email = e.email.ciphertext ? '[Encrypted Email]' : String(e.email);
            }
            if (e.phone && typeof e.phone === 'object') {
                e.phone = e.phone.ciphertext ? '[Encrypted Phone]' : String(e.phone);
            }
            if (e.name && typeof e.name === 'object') {
                e.name = e.name.ciphertext ? '[Encrypted Name]' : String(e.name);
            }
            if (e.username && typeof e.username === 'object') {
                e.username = e.username.ciphertext ? '[Encrypted User]' : String(e.username);
            }
            return e;
        });
        res.json(safeEmployees);
    } catch (error) {
        sendErrorResponse(res, error, "Failed to retrieve employees");
    }
});

/**
 * @route POST /api/admin/employees
 * @desc Register a new employee
 */
router.post("/employees", async (req, res) => {
    try {
        const data = req.body;

        // Auto generate ID if not supplied by frontend
        if (!data.id) {
            data.id = `emp_${uuidv4().substring(0, 8)}`;
        }

        // Role safety formatting
        if (data.backendRole === 'admin') {
            data.role = 'Admin';
        } else {
            data.role = 'Staff';
        }

        const employee = new Employee(data);
        await employee.save();

        res.status(201).json({ success: true, message: "Employee registered successfully", employee });
    } catch (error) {
        if (error.code === 11000) { // MongoDB duplicate key
            return res.status(400).json({ success: false, message: "An employee with this username or email already exists" });
        }
        sendErrorResponse(res, error, "Failed to register employee");
    }
});

/**
 * @route PUT /api/admin/employees/:id
 * @desc Update an existing employee
 */
router.put("/employees/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        // Standardize role string format
        if (updateData.backendRole === 'admin') {
            updateData.role = 'Admin';
        } else if (updateData.backendRole) {
            updateData.role = 'Staff';
        }

        // We use id (String) matching, not _id
        const employee = await Employee.findOneAndUpdate(
            { id },
            { $set: updateData },
            { new: true }
        );

        if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });

        res.json({ success: true, message: "Employee updated successfully", employee });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ success: false, message: "Username or email is already taken by another user" });
        }
        sendErrorResponse(res, error, "Failed to update employee");
    }
});

/**
 * @route DELETE /api/admin/employees/:id
 * @desc Delete an employee
 */
router.delete("/employees/:id", async (req, res) => {
    try {
        const { id } = req.params;

        const employee = await Employee.findOneAndDelete({ id });

        if (!employee) return res.status(404).json({ success: false, message: "Employee not found" });

        res.json({ success: true, message: "Employee deleted successfully" });
    } catch (error) {
        sendErrorResponse(res, error, "Failed to delete employee");
    }
});

/**
 * @route GET /api/admin/payments
 * @desc Get all payments mapped from orders with summary statistics
 */
router.get("/payments", async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || "";
        const status = req.query.status || "";
        const method = req.query.method || "";
        const startDate = req.query.startDate || "";
        const endDate = req.query.endDate || "";

        let match = {};

        if (search) {
            match["$or"] = [
                { orderId: { $regex: search, $options: "i" } },
                { "paymentDetails.transactionId": { $regex: search, $options: "i" } },
                { "shippingAddress.fullName": { $regex: search, $options: "i" } },
                { "shippingAddress.email": { $regex: search, $options: "i" } },
                { "shippingAddress.phone": { $regex: search, $options: "i" } }
            ];
        }

        if (status) match["paymentDetails.status"] = status;
        // In the Order schema, payment method isn't strictly defined, but COD is sometimes in shippingDetails.method or we can match other fields if available.
        // Assuming COD / Online mapping - we use a regex or known fields
        if (method === "COD") {
            // Simplified condition; tweak based on exact DB schema if needed
            match["shippingDetails.method"] = { $regex: "COD", $options: "i" };
        } else if (method === "ONLINE") {
            match["shippingDetails.method"] = { $not: { $regex: "COD", $options: "i" } };
        }

        if (startDate || endDate) {
            match["createdAt"] = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                match["createdAt"].$gte = start.toISOString();
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                match["createdAt"].$lte = end.toISOString();
            }
        }

        const skip = (page - 1) * limit;

        const [orders, totalOrders] = await Promise.all([
            Order.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Order.countDocuments(match)
        ]);

        const summaryPipeline = [
            {
                $group: {
                    _id: null,
                    totalSales: { $sum: { $cond: [{ $eq: ["$paymentDetails.status", "SUCCESS"] }, "$total", 0] } },
                    totalTransactions: { $sum: { $cond: [{ $eq: ["$paymentDetails.status", "SUCCESS"] }, 1, 0] } },
                    pendingAmount: { $sum: { $cond: [{ $eq: ["$paymentDetails.status", "PENDING"] }, "$total", 0] } },
                    pendingCount: { $sum: { $cond: [{ $eq: ["$paymentDetails.status", "PENDING"] }, 1, 0] } },
                    failedCount: { $sum: { $cond: [{ $eq: ["$paymentDetails.status", "FAILED"] }, 1, 0] } },
                    refundedCount: { $sum: { $cond: [{ $eq: ["$paymentDetails.status", "REFUNDED"] }, 1, 0] } },
                    codTransactions: { $sum: { $cond: [{ $regexMatch: { input: { $ifNull: ["$shippingDetails.method", ""] }, regex: /COD/i } }, 1, 0] } },
                    onlineTransactions: { $sum: { $cond: [{ $not: { $regexMatch: { input: { $ifNull: ["$shippingDetails.method", ""] }, regex: /COD/i } } }, 1, 0] } }
                }
            }
        ];

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        const startOfWeekStr = startOfWeek.toISOString();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const timePipeline = [
            {
                $group: {
                    _id: null,
                    todaySales: {
                        $sum: { $cond: [{ $and: [{ $eq: ["$paymentDetails.status", "SUCCESS"] }, { $gte: ["$createdAt", startOfToday] }] }, "$total", 0] }
                    },
                    weekSales: {
                        $sum: { $cond: [{ $and: [{ $eq: ["$paymentDetails.status", "SUCCESS"] }, { $gte: ["$createdAt", startOfWeekStr] }] }, "$total", 0] }
                    },
                    monthSales: {
                        $sum: { $cond: [{ $and: [{ $eq: ["$paymentDetails.status", "SUCCESS"] }, { $gte: ["$createdAt", startOfMonth] }] }, "$total", 0] }
                    }
                }
            }
        ];

        const trendPipeline = [
            { $match: { "paymentDetails.status": "SUCCESS" } },
            { $project: { date: { $substr: ["$createdAt", 0, 10] }, total: "$total" } },
            { $group: { _id: "$date", revenue: { $sum: "$total" }, transactions: { $sum: 1 } } },
            { $sort: { _id: 1 } },
            { $limit: 30 }
        ];

        const [summaryResults, timeResults, trendDataRaw] = await Promise.all([
            Order.aggregate(summaryPipeline),
            Order.aggregate(timePipeline),
            Order.aggregate(trendPipeline)
        ]);

        const summary = summaryResults[0] || { totalSales: 0, totalTransactions: 0, pendingAmount: 0, pendingCount: 0, failedCount: 0, refundedCount: 0, codTransactions: 0, onlineTransactions: 0 };
        const timeSummary = timeResults[0] || { todaySales: 0, weekSales: 0, monthSales: 0 };
        const trendData = trendDataRaw.map(t => ({ date: t._id, revenue: t.revenue, transactions: t.transactions }));

        res.json({
            success: true,
            data: orders,
            summary: { ...summary, ...timeSummary },
            trendData,
            pagination: {
                total: totalOrders,
                page,
                limit,
                pages: Math.ceil(totalOrders / limit)
            }
        });
    } catch (error) {
        sendErrorResponse(res, error, "Failed to retrieve payments data");
    }
});

module.exports = router;
