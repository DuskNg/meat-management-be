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
 * Tải ảnh lên Cloudinary từ chuỗi Base64 hoặc URL
 * @param {string} fileData - Chuỗi data URI base64 hoặc URL ảnh
 * @param {Object} [options] - Tùy chọn bổ sung (folder, public_id, v.v.)
 * @returns {Promise<{ secure_url: string, public_id: string }>}
 */
const uploadToCloudinary = async (fileData, options = {}) => {
  if (!isCloudinaryConfigured()) {
    console.warn('[CLOUDINARY] Chưa cấu hình API Keys trong biến môi trường. Vui lòng cấu hình CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.');
    return null;
  }

  try {
    const uploadOptions = {
      folder: options.folder || 'meat_invoices',
      resource_type: 'image',
      format: 'jpg',
      quality: 'auto:good', // Tối ưu chất lượng tự động để giữ dung lượng nhẹ
      fetch_format: 'auto',
      ...options,
    };

    const result = await cloudinary.uploader.upload(fileData, uploadOptions);
    return {
      secure_url: result.secure_url,
      public_id: result.public_id,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    console.error('[CLOUDINARY] Lỗi tải ảnh lên Cloudinary:', error.message);
    throw error;
  }
};

/**
 * Xóa ảnh trên Cloudinary theo publicId
 * @param {string} publicId
 * @returns {Promise<any>}
 */
const deleteFromCloudinary = async (publicId) => {
  if (!isCloudinaryConfigured() || !publicId) return null;
  try {
    return await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.error('[CLOUDINARY] Lỗi xóa ảnh trên Cloudinary:', error.message);
    return null;
  }
};

module.exports = {
  cloudinary,
  isCloudinaryConfigured,
  uploadToCloudinary,
  deleteFromCloudinary,
};
