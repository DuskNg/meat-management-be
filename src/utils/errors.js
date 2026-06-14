// meat-management-be/src/utils/errors.js

// Lớp Lỗi Cơ Bản (Base Application Error)
class AppError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Lỗi Tham Số / Dữ Liệu Sai (400 Bad Request)
class BadRequestError extends AppError {
  constructor(message = 'Dữ liệu yêu cầu không hợp lệ.', code = 'BAD_REQUEST') {
    super(message, 400, code);
  }
}

// Lỗi Chưa Xác Thực (401 Unauthorized)
class UnauthorizedError extends AppError {
  constructor(message = 'Vui lòng đăng nhập để thực hiện hành động này.', code = 'UNAUTHORIZED') {
    super(message, 401, code);
  }
}

// Lỗi Không Đủ Quyền Hạn (403 Forbidden)
class ForbiddenError extends AppError {
  constructor(message = 'Bạn không có quyền thực hiện hành động này.', code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}

// Lỗi Không Tìm Thấy (404 Not Found)
class NotFoundError extends AppError {
  constructor(message = 'Tài nguyên yêu cầu không tồn tại.', code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

// Lỗi Xung Đột Dữ Liệu (409 Conflict)
class ConflictError extends AppError {
  constructor(message = 'Dữ liệu đã tồn tại hoặc có sự xung đột.', code = 'CONFLICT') {
    super(message, 409, code);
  }
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};
