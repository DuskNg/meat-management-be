// meat-management-be/src/routes/media.js
const express = require('express');
const router = express.Router();
const mediaController = require('../controllers/media');

// Tuyến đường công khai hỗ trợ stream video với chuẩn HTTP Range 206
router.get('/stream', mediaController.streamMedia);

module.exports = router;
