const express = require("express");
const router = express.Router();
const Employee = require("../models/Employee");
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

module.exports = router;
