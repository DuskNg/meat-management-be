// meat-management-be/src/routes/scheduledPriceUpdate.js
const express = require('express');
const router = express.Router();
const scheduledPriceUpdateController = require('../controllers/scheduledPriceUpdate');
const { authenticateToken } = require('../middlewares/auth');

// Toàn bộ API lịch cập nhật giá thịt yêu cầu đăng nhập
router.use(authenticateToken);

router.get('/', scheduledPriceUpdateController.getScheduledPriceUpdates);
router.post('/', scheduledPriceUpdateController.createScheduledPriceUpdate);
router.put('/:id', scheduledPriceUpdateController.updateScheduledPriceUpdate);
router.post('/:id/apply-now', scheduledPriceUpdateController.applyNowScheduledPriceUpdate);
router.delete('/:id', scheduledPriceUpdateController.deleteScheduledPriceUpdate);

module.exports = router;
