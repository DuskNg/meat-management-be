// meat-management-be/src/utils/cloudinary.js
const cloudinary = require('cloudinary').v2;

// Cấu hình Cloudinary SDK từ biến môi trường
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;
const cloudinaryUrl = process.env.CLOUDINARY_URL;

if (cloudinaryUrl) {
  cloudinary.config({ cloudinary_url: cloudinaryUrl });
} else if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

const { isR2Configured, uploadToR2, deleteFromR2 } = require('./r2');

/**
 * Kiểm tra xem dịch vụ lưu trữ đám mây (Cloudflare R2 hoặc Cloudinary) đã được cấu hình hay chưa
 * @returns {boolean}
 */
const isCloudinaryConfigured = () => {
  if (isR2Configured()) return true;
  if (process.env.CLOUDINARY_URL) return true;
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
};

/**
 * Tải ảnh hoặc video lên Đám mây (Tự động ưu tiên Cloudflare R2 miễn phí băng thông, fallback sang Cloudinary)
 * @param {string} fileData - Chuỗi data URI base64, URL hoặc đường dẫn file trên đĩa
 * @param {Object} [options] - Tùy chọn bổ sung (folder, public_id, resource_type, filePath, v.v.)
 * @returns {Promise<{ secure_url: string, public_id: string, resource_type: string }>}
 */
const uploadToCloudinary = async (fileData, options = {}) => {
  // Ưu tiên tải lên Cloudflare R2 nếu đã được cấu hình
  if (isR2Configured()) {
    return await uploadToR2(fileData, options);
  }

  if (!isCloudinaryConfigured()) {
    console.warn('[STORAGE] Chưa cấu hình dịch vụ đám mây (Cloudflare R2 hoặc Cloudinary).');
    return null;
  }

  const fs = require('fs');
  const maxRetries = 3;

  // Xác định file path thực tế trên đĩa nếu có
  const localFilePath = options.filePath || (typeof fileData === 'string' && !fileData.startsWith('data:') && !fileData.startsWith('http') && fs.existsSync(fileData) ? fileData : null);

  const isVideo =
    options.resource_type === 'video' ||
    (typeof fileData === 'string' && (
      fileData.startsWith('data:video/') ||
      /\.(mp4|mov|webm|m4v|avi|mkv)($|\?)/i.test(fileData)
    )) ||
    (localFilePath && /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(localFilePath));

  let uploadOptions = {
    folder: options.folder || 'meat_invoices',
    ...options,
  };

  if (isVideo) {
    uploadOptions = {
      ...uploadOptions,
      resource_type: 'video',
      chunk_size: 6000000, // Tải phân đoạn 6MB chống tràn RAM và timeout
    };
  } else {
    uploadOptions = {
      resource_type: 'image',
      format: 'jpg',
      quality: 'auto:good', // Tối ưu chất lượng tự động để giữ dung lượng nhẹ
      fetch_format: 'auto',
      ...uploadOptions,
    };
  }

  // Cơ chế retry với exponential backoff (2s, 4s, 8s)
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let result = null;
      // Nếu là video và có file path trên đĩa cứng, ưu tiên dùng upload_large truyền luồng file
      if (isVideo && localFilePath && fs.existsSync(localFilePath)) {
        result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_large(localFilePath, uploadOptions, (err, res) => {
            if (err) return reject(err);
            resolve(res);
          });
        });
      } else {
        const sourceToUpload = localFilePath || fileData;
        result = await cloudinary.uploader.upload(sourceToUpload, uploadOptions);
      }

      let finalUrl = result.secure_url || result.url;
      // Với video từ iPhone (.mov), chuẩn hóa đuôi URL thành .mp4 để Cloudinary tự động chuyển mã H.264
      if (isVideo && finalUrl && /\.mov(\?.*)?$/i.test(finalUrl)) {
        finalUrl = finalUrl.replace(/\.mov(\?.*)?$/i, '.mp4$1');
      }

      return {
        secure_url: finalUrl,
        public_id: result.public_id,
        resource_type: result.resource_type || (isVideo ? 'video' : 'image'),
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        duration: result.duration, // Thời lượng video (nếu là video)
      };
    } catch (error) {
      lastError = error;
      console.warn(`[CLOUDINARY] Lỗi tải file (Lần ${attempt}/${maxRetries}):`, error.message);
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }

  console.error('[CLOUDINARY] Đã thử lại 3 lần nhưng tải file lên Cloudinary vẫn thất bại:', lastError.message);
  throw lastError;
};

/**
 * Xóa ảnh hoặc video trên Cloudflare R2 hoặc Cloudinary theo publicId/URL
 * @param {string} publicId
 * @param {Object} [options] - { resource_type: 'image' | 'video' }
 * @returns {Promise<any>}
 */
const deleteFromCloudinary = async (publicId, options = {}) => {
  if (!publicId) return null;

  // Nếu là file trên Cloudflare R2 (chứa domain r2.dev hoặc key R2)
  const r2Domain = (process.env.R2_PUBLIC_DOMAIN || '').replace(/\/+$/, '');
  if (isR2Configured() && (publicId.includes('.r2.dev') || (r2Domain && publicId.includes(r2Domain)))) {
    return await deleteFromR2(publicId);
  }

  if (!isCloudinaryConfigured()) return null;
  try {
    const resource_type = options.resource_type || (publicId.includes('/video/') || options.isVideo ? 'video' : 'image');
    return await cloudinary.uploader.destroy(publicId, { resource_type });
  } catch (error) {
    console.error('[STORAGE] Lỗi xóa file:', error.message);
    return null;
  }
};

module.exports = {
  cloudinary,
  isCloudinaryConfigured,
  uploadToCloudinary,
  deleteFromCloudinary,
  // Cloudflare R2 direct exports
  isR2Configured,
  uploadToR2,
  deleteFromR2,
};
