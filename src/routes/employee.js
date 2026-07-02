// meat-management-be/src/routes/employee.js
const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employee');
const { authenticateToken } = require('../middlewares/auth');

// Tất cả các tuyến đường cần xác thực người dùng
router.use(authenticateToken);

// API CRUD Nhân viên
router.get('/', employeeController.getEmployees);
router.post('/', employeeController.createEmployee);
router.put('/:id', employeeController.updateEmployee);
router.delete('/:id', employeeController.deleteEmployee);

// API Chấm công
router.get('/attendance', employeeController.getAttendances);
router.post('/attendance', employeeController.saveAttendance);

// API Tạm ứng lương
router.post('/advances', employeeController.createSalaryAdvance);

// API Tính toán và thanh toán lương
router.get('/salary/calculate', employeeController.calculateSalary);
router.post('/salary/pay', employeeController.paySalary);

// Lịch sử của nhân viên
router.get('/:id/history', employeeController.getEmployeeHistory);

module.exports = router;
