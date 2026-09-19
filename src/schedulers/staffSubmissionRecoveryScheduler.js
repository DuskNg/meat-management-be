// meat-management-be/src/schedulers/staffSubmissionRecoveryScheduler.js
const path = require('path');
const fs = require('fs');
const prisma = require('../utils/db');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { parseStaffSubmission } = require('../services/aiInvoiceParser');

let isRecovering = false;

/**
 * Tự động phục hồi các submission bị kẹt hoặc chưa hoàn tất tải lên Cloudinary
 */
const recoverStuckSubmissions = async () => {
  if (isRecovering) return;
  isRecovering = true;

  try {
    const now = new Date();
    // 1. Phục hồi các bản ghi bị kẹt ở trạng thái ANALYZING quá 3 phút (thường do server restart hoặc mất mạng giữa chừng)
    const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);
    const stuckAnalyzing = await prisma.staffSubmission.findMany({
      where: {
        status: 'ANALYZING',
        updatedAt: { lt: threeMinutesAgo },
      },
      take: 10,
    });

    for (const sub of stuckAnalyzing) {
      console.log(`[AUTO_RECOVERY] Đang phục hồi quét AI cho submission bị kẹt: ${sub.id}`);
      try {
        await parseStaffSubmission(sub.id);
      } catch (err) {
        console.error(`[AUTO_RECOVERY] Lỗi khi phục hồi submission ${sub.id}:`, err.message);
      }
    }

    // 2. Phục hồi các bản ghi video/ảnh còn link nội bộ /uploads/ nếu file còn trên ổ đĩa
    const localUploads = await prisma.staffSubmission.findMany({
      where: {
        fileUrl: { startsWith: '/uploads/' },
      },
      take: 10,
    });

    for (const sub of localUploads) {
      try {
        const relativePath = sub.fileUrl.replace(/^\//, '');
        const diskPath = path.join(__dirname, '../../', relativePath);

        if (fs.existsSync(diskPath)) {
          console.log(`[AUTO_RECOVERY] Đang tải lên Cloudinary cho file cục bộ: ${sub.fileUrl}`);
          const isVideo = sub.fileType === 'VIDEO' || /\.(mp4|mov|webm|avi|mkv)$/i.test(diskPath);
          const uploadRes = await uploadToCloudinary(diskPath, {
            filePath: diskPath,
            folder: `meat_manager/${sub.userId}/staff_submissions`,
            resource_type: isVideo ? 'video' : 'image',
          });

          if (uploadRes && uploadRes.secure_url) {
            await prisma.staffSubmission.update({
              where: { id: sub.id },
              data: { fileUrl: uploadRes.secure_url },
            });

            // Nếu đang PENDING hoặc ANALYZING, tiến hành quét AI
            if (sub.status === 'PENDING' || sub.status === 'ANALYZING') {
              parseStaffSubmission(sub.id).catch((pErr) => {
                console.error(`[AUTO_RECOVERY] Lỗi quét AI sau khi upload Cloudinary ${sub.id}:`, pErr.message);
              });
            }
          }
        }
      } catch (uploadErr) {
        console.warn(`[AUTO_RECOVERY] Không thể tải file ${sub.id} lên Cloudinary:`, uploadErr.message);
      }
    }
  } catch (error) {
    console.error('[AUTO_RECOVERY_ERROR]:', error);
  } finally {
    isRecovering = false;
  }
};

/**
 * Khởi chạy Scheduler tự phục hồi submission
 */
const initStaffSubmissionRecoveryScheduler = () => {
  // Chạy lần đầu sau 10 giây khi server khởi động xong
  setTimeout(() => {
    recoverStuckSubmissions();
  }, 10 * 1000);

  // Lặp lại mỗi 3 phút
  setInterval(() => {
    recoverStuckSubmissions();
  }, 3 * 60 * 1000);

  console.log('🛡️ [SCHEDULER] Tiến trình tự động phục hồi đơn nộp nhân viên (Auto-Recovery) đã được kích hoạt.');
};

module.exports = {
  initStaffSubmissionRecoveryScheduler,
  recoverStuckSubmissions,
};
