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

/**
 * Kiểm tra xem Cloudinary đã được cấu hình đầy đủ biến môi trường hay chưa
 * @returns {boolean}
 */
const isCloudinaryConfigured = () => {
  if (process.env.CLOUDINARY_URL) return true;
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
};

/**
 * Tải ảnh hoặc video lên Cloudinary từ chuỗi Base64 hoặc URL
 * @param {string} fileData - Chuỗi data URI base64 hoặc URL ảnh/video
 * @param {Object} [options] - Tùy chọn bổ sung (folder, public_id, resource_type, v.v.)
 * @returns {Promise<{ secure_url: string, public_id: string, resource_type: string }>}
 */
const uploadToCloudinary = async (fileData, options = {}) => {
  if (!isCloudinaryConfigured()) {
    console.warn('[CLOUDINARY] Chưa cấu hình API Keys trong biến môi trường. Vui lòng cấu hình CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.');
    return null;
  }

  try {
    const isVideo =
      options.resource_type === 'video' ||
      (typeof fileData === 'string' && (
        fileData.startsWith('data:video/') ||
        /\.(mp4|mov|webm|m4v|avi|mkv)($|\?)/i.test(fileData)
      ));

    let uploadOptions = {
      folder: options.folder || 'meat_invoices',
      ...options,
    };

    if (isVideo) {
      uploadOptions = {
        ...uploadOptions,
        resource_type: 'video',
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

    const result = await cloudinary.uploader.upload(fileData, uploadOptions);
    return {
      secure_url: result.secure_url,
      public_id: result.public_id,
      resource_type: result.resource_type || (isVideo ? 'video' : 'image'),
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      duration: result.duration, // Thời lượng video (nếu là video)
    };
  } catch (error) {
    console.error('[CLOUDINARY] Lỗi tải file lên Cloudinary:', error.message);
    throw error;
  }
};

/**
 * Xóa ảnh hoặc video trên Cloudinary theo publicId
 * @param {string} publicId
 * @param {Object} [options] - { resource_type: 'image' | 'video' }
 * @returns {Promise<any>}
 */
const deleteFromCloudinary = async (publicId, options = {}) => {
  if (!isCloudinaryConfigured() || !publicId) return null;
  try {
    const resource_type = options.resource_type || (publicId.includes('/video/') || options.isVideo ? 'video' : 'image');
    return await cloudinary.uploader.destroy(publicId, { resource_type });
  } catch (error) {
    console.error('[CLOUDINARY] Lỗi xóa file trên Cloudinary:', error.message);
    return null;
  }
};

module.exports = {
  cloudinary,
  isCloudinaryConfigured,
  uploadToCloudinary,
  deleteFromCloudinary,
};
