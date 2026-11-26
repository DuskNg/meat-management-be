// meat-management-be/src/routes/scheduledNotification.js
const express = require('express');
const router = express.Router();
const scheduledNotificationController = require('../controllers/scheduledNotification');
const { authenticateToken } = require('../middlewares/auth');

// Toàn bộ API thông báo hẹn ngày yêu cầu đăng nhập
router.use(authenticateToken);

router.get('/', scheduledNotificationController.getNotifications);
router.post('/', scheduledNotificationController.createNotification);
router.put('/:id', scheduledNotificationController.updateNotification);
router.delete('/:id', scheduledNotificationController.deleteNotification);

module.exports = router;
