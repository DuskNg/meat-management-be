// meat-management-be/src/routes/workspace.js
const express = require('express');
const router = express.Router();
const workspaceController = require('../controllers/workspace');
const { authenticateToken } = require('../middlewares/auth');

// Tất cả workspace route yêu cầu đăng nhập
router.use(authenticateToken);

// --- Route dành cho Chủ Workspace ---
// Tạo workspace mới
router.post('/create', workspaceController.createWorkspace);

// Lấy thông tin workspace của chủ (kèm members và pending requests)
router.get('/my', workspaceController.getMyWorkspace);

// Cập nhật tên Workspace
router.put('/update', workspaceController.updateWorkspace);

// Polling danh sách yêu cầu đang chờ (gọn nhẹ cho banner thông báo)
router.get('/pending-requests', workspaceController.getPendingRequests);

// Phê duyệt yêu cầu tham gia
router.post('/approve/:requestId', workspaceController.approveJoinRequest);

// Từ chối yêu cầu tham gia
router.post('/reject/:requestId', workspaceController.rejectJoinRequest);

// Cập nhật quyền của một thành viên
router.put('/members/:memberId/permissions', workspaceController.updateMemberPermissions);

// Kick thành viên ra khỏi workspace
router.delete('/members/:memberId', workspaceController.kickMember);

// Lấy danh sách thao tác/hành vi của các thành viên trong ngày
router.get('/member-actions', workspaceController.getMemberActions);

// --- Route dành cho Nhân Viên ---
// Gửi yêu cầu tham gia workspace qua mã mời
router.post('/join', workspaceController.joinWorkspace);

// Kiểm tra trạng thái yêu cầu tham gia của mình
router.get('/join-status', workspaceController.getJoinStatus);

// Tự rời workspace
router.delete('/leave', workspaceController.leaveWorkspace);

module.exports = router;
