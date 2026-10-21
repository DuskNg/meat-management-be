// meat-management-be/src/routes/employee.js
const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employee');
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');

// Tất cả các tuyến đường cần xác thực người dùng và quyền quản lý nhân viên
router.use(authenticateToken);
router.use(resolveWorkspace); // Chuyển hướng userId sang workspace owner nếu là nhân viên
router.use(requirePermission('canManageEmployees'));

// API CRUD Nhân viên
router.get('/', employeeController.getEmployees);
router.post('/', employeeController.createEmployee);
router.put('/:id', employeeController.updateEmployee);
router.delete('/:id', employeeController.deleteEmployee);

// API Chấm công & Xin nghỉ
router.get('/attendance', employeeController.getAttendances);
router.post('/attendance', employeeController.saveAttendance);
router.post('/leave', employeeController.recordLeave);
router.delete('/leave/:id', employeeController.deleteLeave);

// API Tạm ứng lương
router.post('/advances', employeeController.createSalaryAdvance);

// API Tính toán và thanh toán lương
router.get('/salary/calculate', employeeController.calculateSalary);
router.get('/salary/preview', employeeController.previewSalary);
router.post('/salary/pay', employeeController.paySalary);

// Lịch sử của nhân viên
router.get('/:id/history', employeeController.getEmployeeHistory);

// Đường dẫn chia sẻ Zalo tra cứu lương, chấm công
router.get('/general-share-link', employeeController.getGeneralEmployeeShareLink);
router.get('/:id/share-link', employeeController.getEmployeeShareLink);

module.exports = router;
