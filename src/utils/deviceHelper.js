// meat-management-be/src/utils/deviceHelper.js

/**
 * Trích xuất và định dạng tên thiết bị từ request
 * @param {import('express').Request} req - Đối tượng request Express
 * @returns {string|null} - Tên thiết bị (ví dụ: 'iPhone 11', 'iPhone 12 / 13', 'PC Windows'...)
 */
const resolveDevice = (req) => {
  if (!req || !req.headers) return null;

  // 1. Ưu tiên lấy từ header do Frontend nhận diện chính xác phần cứng màn hình gửi lên
  const clientDevice = req.headers['x-client-device'];
  if (clientDevice) {
    try {
      const decoded = decodeURIComponent(clientDevice).trim();
      if (decoded) return decoded;
    } catch {
      return String(clientDevice).trim();
    }
  }

  // 2. Fallback: Phân tích từ User-Agent nếu không có header riêng
  const ua = req.headers['user-agent'] || '';
  if (!ua) return null;

  // Kiểm tra iPhone
  if (/iPhone/i.test(ua)) {
    const osMatch = ua.match(/OS (\d+[_\d]*)/i);
    const osVersion = osMatch ? ` (iOS ${osMatch[1].replace(/_/g, '.')})` : '';
    return `iPhone${osVersion}`;
  }

  // Kiểm tra iPad
  if (/iPad/i.test(ua)) {
    return 'iPad';
  }

  // Kiểm tra Android
  if (/Android/i.test(ua)) {
    // Thử trích xuất model máy (ví dụ: SM-S918B, Redmi Note...)
    const modelMatch = ua.match(/\(([^;]+);\s*([^;]+);\s*([^;)]+)\s*Build/i);
    if (modelMatch && modelMatch[3]) {
      const model = modelMatch[3].trim();
      return `Android (${model})`;
    }
    return 'Điện thoại Android';
  }

  // Kiểm tra Windows
  if (/Windows/i.test(ua)) {
    return 'PC Windows';
  }

  // Kiểm tra Mac OS
  if (/Macintosh|Mac OS/i.test(ua)) {
    return 'MacBook';
  }

  // Kiểm tra Linux
  if (/Linux/i.test(ua)) {
    return 'PC Linux';
  }

  return 'Trình duyệt Web';
};

module.exports = {
  resolveDevice,
};
