// meat-management-be/src/utils/requestContext.js
const { AsyncLocalStorage } = require('async_hooks');

// Khởi tạo bộ lưu trữ ngữ cảnh request bất đồng bộ
const requestStorage = new AsyncLocalStorage();

/**
 * Lấy request hiện tại từ context
 */
const getRequest = () => {
  const store = requestStorage.getStore();
  return store ? store.req : null;
};

module.exports = {
  requestStorage,
  getRequest,
};
