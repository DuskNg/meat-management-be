// meat-management-be/src/utils/searchHelper.js

/**
 * Loại bỏ dấu tiếng Việt để phục vụ so khớp và tìm kiếm chuỗi
 */
const removeDiacritics = (str) => {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
};

module.exports = {
  removeDiacritics,
};
