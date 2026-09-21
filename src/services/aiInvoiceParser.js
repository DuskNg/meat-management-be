// meat-management-be/src/services/aiInvoiceParser.js
const fs = require('fs');
const path = require('path');
const prisma = require('../utils/db');
const { callGeminiWithRetry } = require('../utils/geminiHelper');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper loại bỏ dấu tiếng Việt để so khớp tên khách hàng và tên sản phẩm thịt
const removeDiacritics = (str) => {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
};

// Helper chuẩn hóa khối lượng cân thịt (xử lý trường hợp đọc liên tiếp các số cân điện tử: 1 9 5 -> 1.95, 1 6 9 2 -> 16.92)
const normalizeWeightQuantity = (val) => {
  if (val == null) return null;
  let str = String(val).trim();
  if (!str) return null;

  // Thay dấu phẩy tiếng Việt thành dấu chấm
  str = str.replace(',', '.');

  // Nếu đã là số có dấu chấm thập phân hợp lệ (ví dụ: "1.95", "16.92", "4.84")
  if (/^\d+\.\d+$/.test(str)) {
    const num = parseFloat(str);
    return isNaN(num) ? null : num;
  }

  // Trường hợp chuỗi có khoảng trắng giữa các chữ số (ví dụ: "1 9 5", "1 6 9 2", "16 92", "4 8 4")
  const digitsOnly = str.replace(/\s+/g, '');
  if (/^\d+$/.test(digitsOnly)) {
    const len = digitsOnly.length;
    // Nếu có 3 chữ số liên tiếp (ví dụ "195" -> 1.95, "484" -> 4.84, "370" -> 3.7)
    if (len === 3) {
      const num = parseFloat(`${digitsOnly.slice(0, 1)}.${digitsOnly.slice(1)}`);
      return isNaN(num) ? null : num;
    }
    // Nếu có 4 chữ số liên tiếp (ví dụ "1692" -> 16.92, "2015" -> 20.15)
    if (len === 4) {
      const num = parseFloat(`${digitsOnly.slice(0, 2)}.${digitsOnly.slice(2)}`);
      return isNaN(num) ? null : num;
    }
    // Nếu là số lớn bất thường do AI ghép chữ số liền nhau không có dấu chấm (100 - 9999)
    const rawNum = parseFloat(digitsOnly);
    if (rawNum >= 100 && rawNum < 1000) {
      return parseFloat((rawNum / 100).toFixed(2));
    }
    if (rawNum >= 1000 && rawNum < 10000) {
      return parseFloat((rawNum / 100).toFixed(2));
    }
    return isNaN(rawNum) ? null : rawNum;
  }

  const parsed = parseFloat(str);
  if (!isNaN(parsed)) {
    if (parsed >= 100 && parsed < 1000) {
      return parseFloat((parsed / 100).toFixed(2));
    }
    if (parsed >= 1000 && parsed < 10000) {
      return parseFloat((parsed / 100).toFixed(2));
    }
    return parsed;
  }
  return null;
};

// Helper tải file từ URL thành base64 để gửi tới Gemini inlineData (đọc trực tiếp đĩa cứng nếu là file cục bộ)
const fetchFileAsBase64 = async (url) => {
  if (!url) return null;
  if (url.startsWith('data:')) {
    const [header, data] = url.split(',');
    const mimeMatch = header.match(/data:(.*?);/);
    let mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    // Tự động kiểm tra Magic Bytes từ base64
    if (data && data.length >= 24) {
      try {
        const sampleBuf = Buffer.from(data.substring(0, 64), 'base64');
        if (sampleBuf.length >= 8) {
          const tag = sampleBuf.subarray(4, 8).toString('ascii');
          if (tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'wide') {
            const brand = sampleBuf.length >= 12 ? sampleBuf.subarray(8, 12).toString('ascii').toLowerCase() : '';
            if (!['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
              mimeType = 'video/mp4';
            }
          } else if (sampleBuf[0] === 0x1a && sampleBuf[1] === 0x45 && sampleBuf[2] === 0xdf && sampleBuf[3] === 0xa3) {
            mimeType = 'video/webm';
          }
        }
      } catch { }
    }

    return {
      mimeType,
      base64Data: data,
    };
  }

  // Nếu là file cục bộ trên máy chủ (ví dụ /uploads/staff_submissions/...)
  if (url.startsWith('/uploads/')) {
    try {
      const filePath = path.join(__dirname, '../..', url);
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        let isVideo = /\.(mp4|mov|webm|avi|mkv)$/i.test(url);

        // Kiểm tra Magic Bytes nhị phân phòng trường hợp file video bị lưu tên đuôi .jpg
        if (!isVideo && buffer.length >= 8) {
          const tag = buffer.subarray(4, 8).toString('ascii');
          if (tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'wide') {
            const brand = buffer.length >= 12 ? buffer.subarray(8, 12).toString('ascii').toLowerCase() : '';
            if (!['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
              isVideo = true;
            }
          } else if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
            isVideo = true;
          }
        }

        const mimeType = isVideo ? 'video/mp4' : (url.endsWith('.png') ? 'image/png' : 'image/jpeg');
        return {
          mimeType,
          base64Data: buffer.toString('base64'),
        };
      }
    } catch (fsErr) {
      console.warn('[AI_PARSER] Lỗi đọc file cục bộ, chuyển sang fetch URL:', fsErr.message);
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Không thể tải file từ URL: ${url} (Mã lỗi: ${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  let contentType = response.headers.get('content-type') || 'image/jpeg';
  let mimeType = contentType.split(';')[0];

  // Kiểm tra Magic Bytes nhị phân của dữ liệu fetch từ Cloudinary / CDN
  if (buffer.length >= 8) {
    const tag = buffer.subarray(4, 8).toString('ascii');
    if (tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'wide') {
      const brand = buffer.length >= 12 ? buffer.subarray(8, 12).toString('ascii').toLowerCase() : '';
      if (!['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
        mimeType = 'video/mp4';
      }
    } else if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
      mimeType = 'video/webm';
    }
  }

  return {
    mimeType,
    base64Data: buffer.toString('base64'),
  };
};

/**
 * Phân tích hóa đơn / video được gửi từ nhân viên bằng Google Gemini AI
 * @param {string} submissionId - ID bản ghi StaffSubmission cần phân tích
 */
const parseStaffSubmission = async (submissionId) => {
  const submission = await prisma.staffSubmission.findUnique({
    where: { id: submissionId },
    include: {
      user: true,
    },
  });

  if (!submission) {
    console.warn(`[AI_PARSER] Không tìm thấy submissionId: ${submissionId}`);
    return;
  }

  const userId = submission.userId;

  try {
    // 1. Cập nhật trạng thái đang phân tích
    await prisma.staffSubmission.update({
      where: { id: submissionId },
      data: { status: 'ANALYZING', aiError: null },
    });

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_ANALYZING', { id: submissionId });

    // 2. Lấy danh sách khách hàng và sản phẩm hiện tại của chủ buôn để làm từ điển đối chiếu cho AI
    const [customers, products] = await Promise.all([
      prisma.customer.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, phone: true },
      }),
      prisma.product.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, defaultPrice: true, unit: true },
      }),
    ]);

    const customerNamesList = customers.map((c) => c.name).join(', ');
    const productNamesList = products.map((p) => p.name).join(', ');

    // 3. Tải tệp thành Base64
    const filePayload = await fetchFileAsBase64(submission.fileUrl);
    if (!filePayload) {
      throw new Error('Không có dữ liệu tệp hợp lệ để phân tích.');
    }

    const isVideo = submission.fileType === 'VIDEO' || filePayload.mimeType.startsWith('video/');

    // Tự động đồng bộ lại DB nếu phát hiện file thực tế là Video nhưng DB đang lưu nhầm IMAGE
    if (isVideo && submission.fileType !== 'VIDEO') {
      await prisma.staffSubmission.update({
        where: { id: submissionId },
        data: { fileType: 'VIDEO' },
      }).catch((syncErr) => console.warn('[SYNC_FILETYPE_ERR]', syncErr.message));
    }

    // 4. Chuẩn bị prompt AI chuyên sâu: Nếu là Video thì LẮNG NGHE GIỌNG NÓI, nếu là Ảnh thì đọc chữ tích kê
    let promptText = '';

    if (isVideo) {
      promptText = `Bạn là trợ lý AI chuyên nghiệp phân tích VIDEO BÁN THỊT / GIAO THỊT bằng cách KẾT HỢP CẢ ÂM THANH (GIỌNG NÓI) VÀ HÌNH ẢNH (QUAN SÁT MẶT CÂN ĐIỆN TỬ VÀ MIẾNG THỊT).

DANH SÁCH KHÁCH HÀNG QUEN THUỘC CỦA CHỦ BUÔN:
[${customerNamesList || 'Chưa có'}]

DANH SÁCH CÁC MÓN THỊT THƯỜNG BÁN:
[${productNamesList || 'Chưa có'}]

NHIỆM VỤ QUAN TRỌNG:
Hãy KẾT HỢP LẮNG NGHE ÂM THANH / GIỌNG NÓI VÀ QUAN SÁT CÁC KHUNG HÌNH VIDEO (đặc biệt là màn hình cân điện tử):

1. Xác định Tên khách hàng (customer_name) từ giọng nói:
   - Nghe xem người nói gọi tên ai hoặc giao cho ai (ví dụ: "Hương", "Hương Mỹ Đình", "Chị Lan", "A Hùng phở", "Quán Tuyết", "Thầy", "Cô Thảo"...).
   - ĐẶC BIỆT: Nếu người nói gọi tên "Hương" (hoặc "Chị Hương", "cô Hương", "Hương Mỹ Đình"), hãy so khớp chuẩn hóa với khách "Hương mỹ đình(xô 230)". Nếu không nhắc tên khách hàng, trả về null.
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "CÔ THẢO (THẦY)":
      + BẤT KỲ VIDEO NÀO ĐỌC LÀ THẦY HOẶC CÔ THẢO (ví dụ: "thầy", "Thầy", "cô Thảo", "cô thảo", "Thảo", "cô Thảo thầy", "thầy Thảo", "Thảo thầy", "đưa cho thầy", "giao cho thầy", "của thầy", "của cô Thảo"... hoặc bất cứ câu nào có nhắc chữ "thầy" hay "thảo"): BẮT BUỘC trả về customer_name là "Cô thảo(thầy)". Tuyệt đối không để null và không nhầm sang khách khác.
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "CHỊ TUYẾT" / "TUYẾT":
      + Nếu người nói nhắc đến "chị Tuyết", "chị tuyết", "Tuyết", "quán Tuyết", "cô Tuyết", hoặc câu nói dạng: "chín chị tuyết lấy thêm 1.56", "chị Tuyết lấy thêm...", "chị Tuyết một phẩy...", "giao cho chị Tuyết"...:
      + BẮT BUỘC nhận diện customer_name là: "Chị Tuyết" (hoặc tên khách có chữ "Tuyết" trong danh mục).
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "BÚN HUẾ VĂN KHÊ":
      + Nếu người nói đọc là "bún huế", "Bún Huế", "bún huế văn khê", "quán bún huế", "bún bò huế", "bún bò huế văn khê", "Văn Khê", "quán Văn Khê":
      + BẮT BUỘC nhận diện và trả về customer_name là: "Bún huế văn khê" (hoặc tên khách Bún Huế Văn Khê trong danh mục).
    - QUY TẮC ĐẶC BIỆT CHO CÁC BẾP (B1, B2, B3, B4):
      + Nếu đọc là "b1", "b 1", "bê một", "bếp 1", "bếp một", "trường bò 1": BẮT BUỘC trả về customer_name là: "Bếp hàng xóm 1".
      + Nếu đọc là "b2", "b 2", "bê hai", "bếp 2", "bếp hai": BẮT BUỘC trả về customer_name là: "Bếp hàng xóm 2".
      + Nếu đọc là "b3", "b 3", "bê ba", "bếp 3", "bếp ba": BẮT BUỘC trả về customer_name là: "Bếp hàng xóm 3".
      + Nếu đọc là "b4", "b 4", "bê bốn", "bếp 4", "bếp bốn", "vườn xanh", "nhà hàng vườn xanh": BẮT BUỘC trả về customer_name là: "Nhà hàng vườn xanh".
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "HÀ TRÌ" (PHÂN BIỆT VỚI "CHỊ HẠNH SÂN BÓNG HÀ TRÌ" VÀ "CỒ HẢI"):
      + BẤT KỲ VIDEO NÀO NGƯỜI NÓI ĐỌC LÀ "HÀ TRÌ" (hoặc "Hà Trì", "Hà trì", "quán Hà Trì", "anh Hà Trì", "cô Hà Trì", "cô hà trì", "co ha tri", "ha tri", "ha ti"):
      + BẮT BUỘC nhận diện và trả về customer_name là: "Hà Trì".
      + TUYỆT ĐỐI KHÔNG ĐƯỢC NHẬN NHẦM THÀNH "Chị hạnh sân bóng hà trì"! Vì nếu là khách "Chị hạnh sân bóng hà trì" thì người nói sẽ đọc là "chị Hạnh" (hoặc "Hạnh", "chị Hạnh sân bóng"). Khi người nói đọc là "Hà Trì" thì 100% là khách "Hà Trì".
      + TUYỆT ĐỐI KHÔNG gán nhầm sang khách "Cồ Hải" (nếu người nói đọc là "Cồ Hải", "Cổ Hải" thì đó là khách "Cồ hải" riêng biệt, tuyệt đối không gán sang "Hà Trì").
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "CỒ HẢI" / "CỔ HẢI" (CỰC KỲ QUAN TRỌNG):
      + BẤT KỲ VIDEO NÀO NGƯỜI NÓI ĐỌC LÀ "CỒ HẢI", "Cổ Hải", "cồ hải", "cổ hải", "Cồ hải", "anh Hải", "quán Cồ Hải", "quán Cổ Hải":
      + BẮT BUỘC nhận diện và trả về customer_name là: "Cồ hải" (hoặc "Cồ Hải").
      + TUYỆT ĐỐI KHÔNG nhận nhầm sang "Hà Trì" hay khách khác!
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "CHỊ HẠNH SÂN BÓNG HÀ TRÌ":
      + Chỉ khi nào người nói đọc là "chị Hạnh", "chị hạnh", "Hạnh", "Hạnh sân bóng", "chị Hạnh sân bóng", "chị Hạnh hà trì", "sân bóng": BẮT BUỘC mới nhận diện và trả về customer_name là: "Chị hạnh sân bóng hà trì".
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "HUYỀN ĐÔ NGHĨA":
      + Nếu người nói đọc là "Huyền", "chị Huyền", "Huyền Đô Nghĩa", "Huyền đô ngĩa", "cửa hàng Huyền", "quán Huyền":
      + BẮT BUỘC nhận diện và trả về customer_name là: "Huyền Đô Nghĩa".
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "PHỞ TƯỞNG (CHỊ LUYẾN)":
      + Nếu người nói đọc là "phở Tưởng", "quán Tưởng", "anh Tưởng", "chị Luyến", "Phởtưởng", "Phở Tưởng", "Luyến":
      + BẮT BUỘC nhận diện và trả về customer_name là: "Phở tưởng(chị Luyến)" (hoặc "Phở tưởng"). Tuyệt đối không nhầm sang "Phở Tiến" hay khách khác.
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "CHỊ THÚY NGA" (CHINGA):
     + Nếu người nói đọc là "chinga", "Chinga", "chị Nga", "chị nga", "Nga", "cô Nga", "Thúy Nga", "chị Thúy Nga":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Chị Thúy Nga" (hoặc tên khách Thúy Nga trong danh bạ). Tuyệt đối không nhầm sang khách khác.
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "THĂN BÌNH ĐÀ" / "ANH NGHĨA":
     + Nếu người nói đọc là "anh nghĩa", "anh ngĩa", "nghĩa", "ngĩa", "bình đà", "thăn bình đà", "quán bình đà", "anh nghĩa bình đà":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Thăn bình đà(anh Nghĩa)" (hoặc "Thăn bình đà"). Tuyệt đối không nhầm sang khách khác.
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "52 TRẦN THÁI TÔNG":
     + Nếu người nói đọc là "52", "năm hai", "năm mươi hai", "52 trần thái tông", "trần thái tông 52":
     + BẮT BUỘC nhận diện và trả về customer_name là: "52  trần thái tông".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "MINH TRANG":
     + Nếu người nói đọc là "Minh", "minh", "Minh Trang", "minh trang":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Minh trang".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "TRUNG KÍNH" / "BẾP TRUNG KÍNH":
     + Nếu người nói đọc là "Trung Kính", "trung kính", "bếp Trung Kính", "bếp trung kính":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Trung kính".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "THÁI HÀ":
     + Nếu người nói đọc là "Thái Hà", "thái hà", "quán thái hà", "anh thái hà":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Thái hà".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "ANH THẮNG PHỐ CỔ":
     + Nếu người nói đọc là "anh Thắng", "anh thắng", "thắng phố cổ", "anh thắng phố cổ":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Anh thắng phố cổ".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "PHỞ ĐÔNG":
     + Nếu người nói đọc là "phở Đông", "phở đông", "quán phở đông", "anh Đông":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Phở đông".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "GIA HƯNG CS2":
     + Nếu người nói đọc là "Gia Hưng cơ sở 2", "Gia Hưng CS2", "Gia Hưng 2", "Gia Hy CS2":
     + BẮT BUỘC nhận diện và trả về customer_name là: "Gia Hưng cs2".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "VĂN KHÊ" VÀ "BÚN HUẾ VĂN KHÊ":
     + Nếu người nói chỉ đọc là "văn khê", "quán văn khê", "anh văn khê" (KHÔNG có chữ bún huế): BẮT BUỘC trả về customer_name là: "văn khê".
     + Nếu người nói đọc là "bún huế", "bún huế văn khê", "bun hue", "bún bò huế": BẮT BUỘC trả về customer_name là: "Bún huế van khe".
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "GIẢNG VÕ" / "GIANG VÕ":
      + Nếu người nói đọc là "Giảng Võ", "giảng võ", "Giang Võ", "giang võ", "quán Giảng Võ", "anh Giảng Võ":
      + BẮT BUỘC nhận diện và trả về customer_name là: "Giảng võ".
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "794 LÁNG HẠ" / "794 ĐƯỜNG LÁNG" (THE INDUSTREE):
      + Nếu người nói đọc là "794", "794 láng hạ", "794 đường láng", "the industree", "quán 794":
      + BẮT BUỘC trả về customer_name là: "794 láng hạ" (hoặc "the industree(794 đường láng)"). Tuyệt đối không nhầm sang "Cuốn láng hạ".

2. Bóc tách chi tiết các mặt hàng thịt (items) từ GIỌNG NÓI và HÌNH ẢNH MÀN HÌNH CÂN ĐIỆN TỬ:
   - Tên món thịt (name) - QUY TẮC SỐNG CÒN (BẮT BUỘC LUÔN PHẢI CÓ TÊN MÓN THỊT):
     + Trong phần lớn video cân thịt của nhân viên, nhân viên thường chỉ đọc tên khách hoặc chỉ đọc số cân (ví dụ: "Cô Hải 6.42", "chị Tuyết 11.48", "Hương 14.28"...) hoặc đọc tên thịt rất nhanh, nuốt âm, thậm chí KHÔNG ĐỌC TÊN THỊT mà chỉ chĩa camera vào đĩa cân.
     + TUYỆT ĐỐI CẤM để trống tên món thịt (name) hoặc trả về danh sách items rỗng khi thấy có miếng thịt trên cân hoặc màn hình cân có số kg!
     + BẮT BUỘC nhận diện tên món thịt (name) bằng cách KẾT HỢP:
       1) LẮNG NGHE KỸ TỪNG ÂM THANH: Nghe xem có từ chỉ loại thịt nào không (chín, lạm, thăn, tái, gầu, bắp, xô, sườn, nạc, vai xay, bê...).
       2) QUAN SÁT TRỰC TIẾP MIẾNG THỊT TRÊN MẶT ĐĨA CÂN TRONG VIDEO (THỊ GIÁC AI):
          * Miếng thịt đã luộc chín (màu nâu sẫm, da săn, để nguyên tảng chín hoặc thái sẵn) -> Tên món (name): "Thịt chín".
          * Miếng thịt nạc đỏ tươi, thớ dài mịn không mỡ -> Tên món (name): "Thăn" (hoặc "Tái").
          * Miếng thịt có lớp mỡ trắng/vàng viền quanh hoặc xen kẽ thớ nạc -> Tên món (name): "Gầu Bò" (hoặc "Thịt lạm", "Lạm gầu").
          * Khối thịt bắp tròn có vân hoa gân đan xen -> Tên món (name): "Bắp Bò".
          * Tảng sườn, dẻ sườn có xương -> Tên món (name): "Sườn".
          * Thịt xay nhuyễn -> Tên món (name): "Vai xay".
          * Thịt bê có da mỏng dính -> Tên món (name): "Bê ba chỉ".
       3) NẾU HÌNH ẢNH MỜ HOẶC CAMERA CHỈ CHĨA VÀO ĐỒNG HỒ CÂN:
          Dựa vào khách hàng quen để điền tên món thịt mà khách đó chuyên lấy:
          - Nếu là khách Hương (Hương Mỹ Đình): BẮT BUỘC điền món "xô" (giá mặc định 230000).
          - Nếu là khách Chị Tuyết: Điền món "Thăn" (hoặc "Thịt chín").
          - Nếu là khách Cồ Hải: Điền món "Thịt lạm" (hoặc "Lạm gầu").
          - Nếu là khách Phở Tưởng (chị Luyến): Điền món "Gầu Bò" (hoặc "Thịt lạm").
          - Nếu là khách Thăn Bình Đà (Anh Nghĩa): Điền món "Thăn".
          - Khách khác: Chọn loại thịt phù hợp nhất trong danh sách các món thường bán: [${productNamesList}].
   - QUY TẮC ĐẶC BIỆT CHO MÓN "THỊT CHÍN" / "CHÍN" (CỰC KỲ QUAN TRỌNG):
     + Nếu người nói đọc từ "chín", "thịt chín", "bò chín" (ví dụ: "chín chị tuyết lấy thêm 1.56", "chín một phẩy năm sáu", "thịt chín 2 cân", "chín lấy thêm..."):
     + BẮT BUỘC hiểu từ "chín" ở đây là MÓN THỊT CHÍN (không phải số 9 hay từ chỉ trạng thái). Tên món thịt (name) BẮT BUỘC trả về là: "Thịt chín".
     + Các từ ngữ hành động như "lấy thêm", "lấy", "của", "giao thêm", "đưa thêm" chỉ là lời nói hành động, TUYỆT ĐỐI KHÔNG đưa vào tên món thịt.
   - QUY TẮC ĐẶC THÙ CHO KHÁCH "HƯƠNG" (CỰC KỲ QUAN TRỌNG):
     + Nếu trong video đọc tên khách là "Hương" (hoặc "Chị Hương", "cô Hương", "Hương Mỹ Đình"...) và có số cân thịt nhưng KHÔNG ĐỌC TÊN THỊT (ví dụ người nói chỉ đọc: "Hương 5 cân", "Hương bốn phẩy hai cân", "chị Hương 3 cân rưỡi", hoặc chỉ quay cân cho Hương):
       * Tên món thịt (name) BẮT BUỘC trả về là: "xô" (hoặc "thịt xô").
       * Đơn giá (price): nếu không có giá khác, mặc định là 230000 (230k).
       * Thành tiền (amount) = 230000 * số cân.
   - ĐẶC BIỆT PHÂN BIỆT RÕ THỊT LẠM VÀ LẠM GẦU:
     + Nếu người nói đọc là "lạm" (hoặc "nạm", "thịt lạm"): BẮT BUỘC ghi đúng tên là "Thịt lạm".
     + Nếu người nói đọc là "lạm gầu" (hoặc "lạm gàu", "nạm gầu", "lạm và gầu"): BẮT BUỘC ghi đúng tên là "Lạm gầu", tuyệt đối không được nhầm lẫn hay rút gọn.
   - QUY TẮC ĐẶC BIỆT CHO GẦU BÒ (KHI ĐỌC RẤT NHANH, NUỐT CHỮ, LƯỚT ÂM):
     + Trong video, người nói có thể nói rất nhanh, lướt giọng hoặc nuốt chữ nghe thành "gâu", "gầu", "gàu", "gâu bò", "thịt gầu", "thịt gâu", "gầu bò"... (chỉ cần không đi kèm từ "lạm"):
     + BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "Gầu Bò".
   - QUY TẮC ĐẶC BIỆT CHO MÓN "BÊ" (CỰC KỲ QUAN TRỌNG):
     + Nếu trong video người nói đọc là "bê", "thịt bê", "bê ba chỉ":
     + BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "Bê ba chỉ".

   - QUY TẮC ĐẶC BIỆT CHO MÓN "TÁI" (THỊT TÁI):
     + Nếu trong video người nói đọc là "tái", "thịt tái", "bò tái" (ví dụ: "tái 1 9 5", "tái một phẩy chín năm", "thịt tái 2 cân"):
     + BẮT BUỘC nhận diện tên món thịt (name) là: "Tái" (hoặc "Thịt tái").
   - QUY TẮC ĐẶC BIỆT CHO MÓN "BẮP" (BẮP BÒ) (CỰC KỲ QUAN TRỌNG):
     + Nếu trong video người nói đọc là "bắp", "thịt bắp", "bắp bò", "bắp hoa", "quả bắp", "bap" (ví dụ: "bắp 1.6", "bắp 1 6", "bắp 300", "bắp 2 cân", "chị Tuyết bắp...", "trả bắp...", "bắp..."):
     + BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "Bắp Bò". Tuyệt đối không chỉ để là "bắp" cụt lủn hay nhầm sang loại thịt khác.
   - QUY TẮC ĐẶC BIỆT CHO MÓN "VAI XAY" (BÒ XAY):
     + Nếu trong video người nói đọc là "bò xay", "thịt bò xay", "vai xay", "thịt vai xay", "xay":
     + BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "Vai xay".
   - QUY TẮC ĐẶC BIỆT CHO MÓN "THỊT LA VAI" / "LÁ" / "LA" (CỰC KỲ QUAN TRỌNG):
     + Nếu trong video người nói đọc là "lá", "la", "lá vai", "la vai", "thịt la", "thịt lá", "thịt la vai", "thịt lá vai":
     + BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "thịt la vai". Tuyệt đối không chỉ ghi "lá" hay "la" đơn thuần hay nhầm sang món khác.

   - Khối lượng / Số lượng (quantity) - QUY TẮC QUAN TRỌNG KHI ĐỌC SỐ CÂN VÀ NHÌN MÀN HÌNH CÂN ĐIỆN TỬ:
     + QUY TẮC ĐẶC BIỆT: ĐỌC TỪNG CHỮ SỐ LIÊN TIẾP (CÂN ĐIỆN TỬ BỎ DẤU CHẤM/PHẨY):
       * Trong thực tế cân thịt, người đọc thường đọc rất nhanh các chữ số liên tiếp hiển thị trên cân điện tử 2 số lẻ:
       * KHI ĐỌC 3 CHỮ SỐ LIÊN TIẾP (dạng X Y Z): BẮT BUỘC HIỂU LÀ X.YZ kg:
         - Ví dụ: "tái 1 9 5" -> Món: "Tái", Khối lượng (quantity): 1.95 (nghĩa là 1.95 kg).
         - Ví dụ: "1 9 5" hoặc "một chín năm" -> quantity: 1.95.
         - Ví dụ: "4 8 4" hoặc "bốn tám tư" -> quantity: 4.84.
         - Ví dụ: "3 7 0" hoặc "ba bảy mươi" -> quantity: 3.7 (3.70 kg).
         - Ví dụ: "2 4 5" -> quantity: 2.45.
       * KHI ĐỌC 4 CHỮ SỐ LIÊN TIẾP (dạng AB CD): BẮT BUỘC HIỂU LÀ AB.CD kg:
         - Ví dụ: "1 6 9 2" hoặc "mười sáu chín hai" hoặc "một sáu chín hai" -> quantity: 16.92 (nghĩa là 16.92 kg).
         - Ví dụ: "2 0 1 5" hoặc "hai mươi mười lăm" -> quantity: 20.15.
         - Ví dụ: "1 2 5 0" hoặc "mười hai năm mươi" -> quantity: 12.5.
         - Ví dụ: "2 4 8 0" -> quantity: 24.8.
       * TUYỆT ĐỐI KHÔNG để quantity là 195 hay 1692 (không có miếng thịt nào nặng 195kg hay 1692kg)!
     + TRƯỜNG HỢP NÓI RÕ CHỮ "CÂN" / "PHẨY" / "LẺ": (ví dụ: "5 cân" -> 5, "mười cân rưỡi" -> 10.5, "hai phẩy ba cân" -> 2.3, "1 phẩy 79" -> 1.79, "3 lạng" -> 0.3): Lấy số lượng theo lời đọc.
     + QUY TẮC ĐẶC BIỆT TỪ "LẺ" (CÁCH NÓI DÂN GIAN SỐ THẬP PHÂN KG):
       * Khi người nói dùng từ "lẻ" giữa 2 số, nghĩa là dấu phẩy thập phân (giống "phẩy"):
         - "6 lẻ 69" → quantity: 6.69 (tức là 6.69 kg)
         - "4 lẻ 50" hoặc "4 lẻ 5" → quantity: 4.5 (tức là 4.50 kg)
         - "3 lẻ 05" hoặc "3 lẻ 5" → quantity: 3.05 (tức là 3.05 kg)
         - "1 lẻ 20" → quantity: 1.2 (tức là 1.20 kg)
         - "10 lẻ 35" → quantity: 10.35
       * QUY TẮC: [số nguyên] lẻ [số sau dấu thập phân] = [số nguyên].[số sau dấu thập phân] kg.
       * Nếu số sau "lẻ" là 1 chữ số (ví dụ "lẻ 5") thì hiểu là .50 (nửa cân), trừ khi ngữ cảnh rõ ràng là .05.
     + TRƯỜNG HỢP 2 (NGƯỜI DÙNG QUAY VIDEO NHƯNG KHÔNG NÓI SỐ CÂN HOẶC ĐỌC KHÔNG RÕ):
       * BẮT BUỘC QUAN SÁT MÀN HÌNH CÂN ĐIỆN TỬ TRÊN KHUNG HÌNH VIDEO:
       * Trong video, người quay đặt miếng thịt lên cân điện tử tính tiền và camera quay rõ mặt cân.
       * Hãy nhìn vào màn hình LED kỹ thuật số (đèn LED đỏ hoặc xanh) của cân:
         1) Ô "KHỐI LƯỢNG (kg)" (ô trên cùng, ví dụ hiển thị số LED đỏ "1.79", "2.05", "0.86"):
            => ĐỌC CHÍNH XÁC CON SỐ ĐANG HIỂN THỊ ĐỂ LÀM SỐ CÂN (quantity). Ví dụ: màn hình LED hiện "1.79" -> quantity: 1.79.
         2) Ô "ĐƠN GIÁ (đ/kg)" (ô ở giữa, ví dụ hiển thị "200"): Nếu người nói không đọc giá khác, lấy đơn vị nghìn đồng là 200000 VND.
         3) Ô "THÀNH TIỀN (đ)" (ô dưới cùng, ví dụ hiển thị "3.58" hoặc "358"): Nếu có hiển thị, đây là thành tiền (358000 VND).
       * TUYỆT ĐỐI KHÔNG để quantity = 1 nếu trên mặt cân điện tử đang hiển thị số cân rõ ràng!
   - Đơn giá (price): Nếu người nói có đọc đơn giá (ví dụ: "giá 240", "trăm tám một cân" -> 180000) hoặc đọc từ ô Đơn giá trên cân. Nếu không có giá, để null.
   - Thành tiền (amount): Nếu người nói có đọc tổng tiền hoặc đọc từ ô Thành tiền trên cân. Nếu không có thì để null.

3. QUY TẮC ĐẶC BIỆT XÁC ĐỊNH ĐƠN TRẢ HÀNG (CỰC KỲ QUAN TRỌNG):
   - Khi người nói dùng các từ ngữ như: "gửi lại", "gửi về", "trả hàng", "trả về", "trả lại", "hàng trả", "thu hồi", "bắn về", "quay đầu", "đổi trả" (ví dụ: "chín chị tuyết lấy thêm 1.56 trả về...", "gửi lại 2 cân gầu", "chín gửi về một phẩy năm sáu", "chị Tuyết gửi về...", "trả hàng 2 cân gầu", "trả về 3 cân thịt chín", "gửi lại 1.2kg thăn"...):
   - BẮT BUỘC nhận diện đây là ĐƠN TRẢ HÀNG (khách gửi hàng trả lại để giảm trừ nợ, KHÔNG phải đơn mua mới):
     + BẮT BUỘC đặt "is_return": true (đơn bán bình thường là false).
     + BẮT BUỘC đặt "note": "[Trả lại hàng]" (nếu có nội dung thêm thì ghép vào sau, ví dụ: "[Trả lại hàng] Khách gửi lại").
     + Vẫn bóc tách chính xác customer_name và items (tên món thịt, số cân, giá, tiền).
     + Các từ ngữ "gửi lại", "gửi về", "trả hàng", "trả về", "trả lại", "hàng trả" CHỈ DÙNG ĐỂ XÁC ĐỊNH LOẠI ĐƠN, TUYỆT ĐỐI CẤM đưa vào tên khách hàng (customer_name) hay tên món thịt (name)!

4. Lưu ý:
   - Người nói có thể dùng khẩu ngữ tiếng Việt (cân = kg, lạng = 0.1kg, rưỡi = .5, chẵn...).
   - BẮT BUỘC kết hợp cả nghe giọng nói và nhìn hình ảnh màn hình LED đỏ của cân điện tử để đảm bảo luôn lấy được số cân chính xác nhất.

Chỉ trả về JSON theo đúng cấu trúc:
{
  "customer_name": "Tên khách hàng hoặc null",
  "is_return": false,
  "note": "Ghi chú nếu có (hoặc '[Trả lại hàng]' nếu là đơn trả)",
  "items": [
    {
      "name": "Tên món thịt",
      "quantity": 2.5,
      "price": 240000,
      "amount": 600000
    }
  ]
}`;
    } else {
      promptText = `Bạn là trợ lý AI chuyên gia hàng đầu về đọc và phân tích hóa đơn, tích kê bán buôn thịt bò viết tay của cửa hàng thịt Trường Nga (Bò - Trâu - Bê).

DANH SÁCH KHÁCH HÀNG QUEN THUỘC CỦA CHỦ BUÔN:
[${customerNamesList || 'Chưa có'}]

DANH SÁCH CÁC MÓN THỊT THƯỜNG BÁN:
[${productNamesList || 'Chưa có'}]

HÃY QUAN SÁT VÀ BÓC TÁCH THEO ĐÚNG CÁC QUY TẮC BẮT BUỘC SAU:

0. QUY TẮC BẮT BUỘC: KIỂM TRA BỐ CỤC HÓA ĐƠN BÁN HÀNG (CỰC KỲ QUAN TRỌNG):
   - CHỈ QUÉT VÀ BÓC TÁCH KHI ẢNH CÓ BỐ CỤC CỦA MỘT TỜ HÓA ĐƠN BÁN HÀNG TIÊU CHUẨN:
     + Mặt trước tờ hóa đơn có in tiêu đề "HÓA ĐƠN BÁN HÀNG" (hoặc "PHIẾU GIAO HÀNG", "CHUYÊN: BÁN BUÔN - BÁN LẺ...").
     + Có bảng biểu kẻ ô chia các cột rõ ràng (STT, Tên hàng hóa, Số lượng, Đơn giá, Thành tiền) hoặc có dòng in sẵn "Tên khách hàng: ...".
   - CÁC TRƯỜNG HỢP TUYỆT ĐỐI KHÔNG ĐƯỢC QUÉT (ĐÂY KHÔNG PHẢI HÓA ĐƠN BÁN HÀNG):
     + Ảnh chụp mẩu giấy nháp trắng trơn, không có tiêu đề in hóa đơn, không có khung bảng biểu.
     + Ảnh chụp MẶT SAU (MẶT LƯNG) của tờ hóa đơn để viết nháp vài con số linh tinh (mặt sau giấy trắng, chữ in hóa đơn bị lộn ngược mờ ở phía sau).
     + Giấy xé tay tự do chỉ viết vài con số tính nhẩm nghuệch ngoạc không có bố cục hóa đơn.
     => KHI GẶP CÁC ẢNH NÀY: TUYỆT ĐỐI KHÔNG ĐƯỢC QUÉT / BÓC TÁCH CÁC CON SỐ NHÁP THÀNH ĐƠN HÀNG!
     => BẮT BUỘC TRẢ VỀ:
        {
          "is_valid_invoice": false,
          "customer_name": null,
          "invoice_date": null,
          "is_return": false,
          "note": "Ảnh không có bố cục hóa đơn bán hàng (giấy nháp/mặt sau)",
          "items": []
        }

1. QUY TẮC BÓC TÁCH MÓN THỊT & SỐ LIỆU (KHI ĐÃ LÀ HÓA ĐƠN HỢP LỆ):
   - BẮT BUỘC BÓC TÁCH CÁC MÓN THỊT THEO ĐÚNG THỨ TỰ TỪ TRÊN XUỐNG DƯỚI (Top-to-Bottom order) của cột "Tên hàng hóa" trên tờ hóa đơn:
     + Tuyệt đối KHÔNG ĐƯỢC ĐẢO LỘN thứ tự các món thịt!
     + Dòng viết đầu tiên ở trên cùng của hóa đơn BẮT BUỘC là phần tử ĐẦU TIÊN (items[0]).
     + Dòng thứ 2 là items[1], dòng thứ 3 là items[2], dòng thứ 4 là items[3]... lần lượt theo đúng thứ tự các dòng kẻ từ trên xuống dưới.
   - LƯU Ý VỀ HƯỚNG ẢNH (ẢNH BỊ XOAY NGANG 90 ĐỘ HOẶC XOAY DỌC):
     + Ảnh chụp giấy nháp hoặc tích kê có thể bị chụp quay ngang 90 độ, quay ngược 180 độ hoặc quay 270 độ.
     + BẮT BUỘC tự động xoay và định hướng theo chiều đọc của chữ viết tay để nhận diện đúng thứ tự các dòng từ trên xuống dưới (ví dụ dòng trên là "bắp 1.6", dòng dưới là "gầu 3.27").
   - Dù hóa đơn có ghi giá tiền hay chỉ ghi tên món và số cân, hãy bóc tách TẤT CẢ các dòng món thịt nhìn thấy được.
   - PHÂN TÍCH ĐẶC TẢ NÉT CHỮ VIẾT TAY CỦA CÁC MÓN THỊT (CỰC KỲ QUAN TRỌNG):
     + "bắp" / "bap" / "Bắp": Chữ "b" nét sổ thẳng đứng cao, chữ "a-p" viết liền thảo, nét đuôi chữ "p" sổ dài xuống dưới dòng kẻ, dấu sắc hoặc mũ nhẹ trên chữ "a". Số cân viết cạnh (ví dụ: "- 1,6" hoặc "1.6" hoặc "1,6"): BẮT BUỘC nhận diện tên là: "Bắp Bò", số lượng (quantity): 1.6.
     + "Gầu" / "Gau" / "gầu bò" / "gàu": Chữ "G" viết hoa thảo uốn lượn cong tròn rất to và điệu đà (nét cong rộng như chữ C lớn có móc lượn vào), nối tiếp "a-u" viết thảo liền mạch, có dấu huyền trên "a". Số cân viết cạnh (ví dụ: "3,27" hoặc "3.27"): BẮT BUỘC nhận diện tên là: "Gầu Bò", số lượng (quantity): 3.27.
     + "Nam" / "Nạm" / "Lạm": Chữ "N" viết đứng 2 nét hoặc chữ "L", chữ "am" nối liền tròn -> BẮT BUỘC trả về: "Nam" (hoặc "Thịt lạm" / "Nạm").
     + "bằng" / "bang" / "quả bằng": Chữ "b" sổ thẳng đứng cao, "ang" có nét đuôi chữ "g" sổ dài thòng xuống dưới dòng, dấu huyền trên "a" -> BẮT BUỘC trả về: "quả bằng".
     + "Trắng" / "trang" / "quả trắng": Chữ "T" viết hoa thẳng có gạch ngang, chữ "r-a-n-g" với đuôi chữ "g" móc dài xuống dưới, dấu á và dấu sắc trên "a" -> BẮT BUỘC trả về: "quả trắng".
     + "Quạt" / "quat": Chữ "Q" viết hoa tròn to lượn đuôi ở đáy, "uat" có gạch ngang dứt khoát của chữ "t" -> BẮT BUỘC trả về: "quạt".
     + "Thăn" / "than" / "thăn bò": Chữ "T" viết hoa có gạch ngang cao, "h-a-n" viết liền nét, dấu á uốn cong trên đầu chữ "a" -> BẮT BUỘC trả về: "Thăn".
     + "xg" / "x" / "xg bò": Chữ "x" chéo mềm mại, chữ "g" đuôi móc dài xuống dưới dòng kẻ (hoặc chỉ ghi 1 ký tự "x" / "X") -> BẮT BUỘC trả về: "Xg Bò".
     + "Tai" hoặc "Tái" (chữ T hoa uốn lượn viết liền chữ ái): BẮT BUỘC trả về tên là "Tái (Bò)".
     + "bắp" hoặc "Bắp": BẮT BUỘC trả về tên là "Bắp Bò".
     + "Lá" / "lá" / "la" / "lá vai" / "la vai" / "thịt la" / "thịt lá" / "thịt la vai": Chữ "L" hoa thảo nét cong cao nối liền chữ "á" hoặc "a" (có thể kèm "vai") -> BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "thịt la vai".
      + "Sườn" / "suon" / "sườn bò": Chữ "S" hoa to lượn sóng mềm mại, "ườn" viết liền nét có dấu huyền -> BẮT BUỘC trả về tên là: "Sườn".
       + PHÂN TÍCH ĐẶC TẢ NÉT CHỮ MÓN "SƯỜN XG" (CẢ DẠNG "SƯỜN XG" LẪN "XƯỜN XG"):
         * Đặc trưng thị giác chữ viết tay:
           1) Từ thứ 1: Chữ "S" in hoa uốn lượn cong to mềm mại vươn cao, theo sau là nét "ườn" viết thảo có nét dấu huyền "\" khá dài chém nghiêng phía trên, kết thúc bằng chữ "n" móc tròn xuống dòng (AI OCR rất dễ nhìn nhầm thành: "Sườn", "Suon", "Scion", "Sian", "Sùn", "Scòn", "Siơn", hoặc người viết theo phương ngữ địa phương dùng chữ "x" viết thành "xườn", "x lơn", "xldn", "xuan", "xian", "x long").
           2) Từ thứ 2: Viết tắt "xG" hoặc "xg" (nghĩa là "xương"):
              - Ký tự đầu: Chữ "x" hai nét chéo giao nhau (viết nhanh nét chéo nhìn giống chữ "k" / "K").
              - Ký tự sau: Chữ "G" hoa tròn có nét sổ thẳng và CÓ NÉT GẠCH CHÂN NGANG "_" Ở ĐÁY.
              - CẢNH BÁO OCR CỰC KỲ NGUY HIỂM: Nét viết "xG" (kèm gạch chân) này rất dễ khiến AI OCR nhìn nhầm thành chữ "KG", "kg", "k.g", "x.g", "xq" (và bị AI hiểu lầm thành đơn vị tính Kilogram).
         * QUY TẮC BẮT BUỘC: Khi ở cột Tên hàng hóa nhìn thấy chữ viết tay dạng:
           "Sườn xg", "Sườn xG", "Sườn KG", "Sườn kg", "Suon kg", "Suon KG", "Sườn k.g", "Sườn x.g", "Sườn xq", "Scion kg", "Scion xg", "Sian xg", "Sian kg", "Sùn xg", "Sùn kg", "Scòn xg", "Siơn xg", "xườn xg", "xườn xương", "sườn xương", "x lơn x lơng", "xldn xldug", "xlan xg", "xuan xg", "s xg", "s kg":
           => BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "Sườn xg", số lượng (quantity) là con số bên cạnh.
     + "bò xay" / "bo xay" / "vai xay" / "thịt bò xay" / "xay": BẮT BUỘC trả về tên là: "Vai xay".
      + PHÂN TÍCH NÉT CHỮ MÓN "BÊ" -> "BÊ BA CHỈ" (CỰC KỲ QUAN TRỌNG):
        * Nét chữ viết tay: Chữ "b" có nét khuyết trên vươn rất cao lên tận mép trên của dòng, thân thẳng đứng, bụng dưới tròn có nét thắt loop nhỏ; chữ "e" viết liền mạch hình bầu dục nhỏ nằm sát bên phải nét thắt, phía trên đầu chữ "e" có nét phẩy hoặc dấu mũ nhỏ (nhìn giống "bê", "be", "bè", "bé", "bc", "b.").
        * Số cân bên cạnh: Ví dụ "12,2" hoặc "12.2" (số 1 nét móc sổ thẳng, số 2 uốn tròn đầu có nét thắt ở chân, dấu phẩy giữa hai số 2) -> quantity: 12.2.
        * QUY TẮC BẮT BUỘC: Khi ở cột Tên hàng hóa ghi "bê", "Bê", "be", "bè", "bé", "thịt bê", "bê ba chỉ":
          => BẮT BUỘC chuẩn hóa và trả về tên món thịt (name) là: "Bê ba chỉ", số lượng (quantity) là số cân bên cạnh (ví dụ 12.2).
      + "chí", "chín", "thịt chín": BẮT BUỘC trả về tên là: "Thịt chín".
     + ĐẶC BIỆT PHÂN BIỆT RÕ THỊT LẠM VÀ LẠM GẦU:
       * Nếu ghi là "lạm", "Lạm", "nạm", "Nạm", "Nam": BẮT BUỘC trả về tên là "Thịt lạm" hoặc "Nam".
       * Nếu ghi là "lạm gầu", "Lạm gầu", "lạm gàu", "Lạm + gầu", "nạm gầu": BẮT BUỘC trả về đúng tên là "Lạm gầu".
   - Các món thịt khác: "Xô", "Dẻ", "Lạc", "U", "Tim"... chuẩn hóa theo danh mục món thịt ở trên.

2. QUY TẮC CỐT LÕI: HÓA ĐƠN ĐƠN NỢ NHANH - CÁC CON SỐ HÀNG TRĂM KHÔNG CÓ DẤU PHẨY LÀ TIỀN, CÓ ĐƯỜNG GẠCH CHÂN TỔNG TIỀN (CỰC KỲ QUAN TRỌNG):
   - ĐẶC ĐIỂM NHẬN DIỆN DẠNG HÓA ĐƠN ĐƠN NỢ NHANH:
     + Ở cột bên cạnh tên các món thịt (kể cả người viết viết vào cột in sẵn chữ "Số lượng", "Đơn giá", hay "Thành tiền"):
     + Các con số được viết là CÁC SỐ NGUYÊN HÀNG TRĂM (ví dụ: "959", "836", "341", "150", "200", "500", "100"...).
     + BẮT BUỘC LƯU Ý: CÁC CON SỐ NÀY HOÀN TOÀN KHÔNG CÓ DẤU PHẨY (,) HAY DẤU CHẤM (.) THẬP PHÂN!
     + Phía dưới các con số có MỘT ĐƯỜNG GẠCH CHÂN / GẠCH NGANG (────────).
     + Phía dưới đường gạch chân là MỘT CON SỐ LỚN HƠN (ví dụ: "2136"), chính là TỔNG CỘNG CỦA CÁC CON SỐ PHÍA TRÊN CỘNG LẠI (959 + 836 + 341 = 2136).
   - NGUYÊN TẮC BẮT BUỘC PHẢI HIỂU VÀ BÓC TÁCH:
     1) ĐÂY LÀ TIỀN (THÀNH TIỀN ĐƠN VỊ NGHÌN ĐỒNG), HOÀN TOÀN KHÔNG PHẢI LÀ SỐ CÂN (KHÔNG PHẢI KG / SỐ LƯỢNG)!
        * Không có miếng thịt nào nặng 959kg hay 836kg!
        * Người viết KHÔNG BAO GIỜ viết "959" để chỉ 9.59kg mà không có dấu phẩy!
        * CẤM nhận diện 959 là 9.59kg, CẤM nhận diện 836 là 8.36kg, CẤM nhận diện 341 là 3.41kg!
        * CẤM biến số hàng trăm không có dấu phẩy thành số cân thập phân!
     2) ĐÂY LÀ DẠNG ĐƠN NỢ NHANH, CHỈ CẦN QUÉT SỐ TIỀN:
        * Bóc tách từng món thịt với số tiền của món đó:
          - Dòng 1: name: "Sườn", quantity: null, price: 959000, amount: 959000 (959 * 1000).
          - Dòng 2: name: "thịt la vai", quantity: null, price: 836000, amount: 836000 (836 * 1000).
          - Dòng 3: name: "Tái", quantity: null, price: 341000, amount: 341000 (341 * 1000).
        * Tổng tiền của hóa đơn: Bằng tổng các dòng = 2136000 (2.136.000 VNĐ, đúng bằng con số 2136 ở dưới đường gạch chân).
     3) BẢO TOÀN SỐ TIỀN AMOUNT:
        * Con số người bán ghi là số tiền chốt của giao dịch nợ nhanh, BẮT BUỘC bảo toàn chính xác amount (959000, 836000, 341000, tổng 2136000), TUYỆT ĐỐI KHÔNG được ghi đè bằng giá riêng hay tự tính lại!
   - HÓA ĐƠN CHỈ CÓ CÁC CON SỐ TIỀN CỘNG LẠI (HOÀN TOÀN KHÔNG VIẾT TÊN MÓN THỊT, VÍ DỤ: 756, 1118, 390 -> TỔNG 2264):
     + ĐÂY LÀ DẠNG HÓA ĐƠN NHẬP NHANH (TIỀN HÀNG).
     + TUYỆT ĐỐI KHÔNG gán tên là "Thịt lẻ" với số cân "-1" hay số âm! Dấu gạch ngang "-" trước con số là nét gạch đầu dòng, TUYỆT ĐỐI KHÔNG PHẢI số cân!
     + Trả về:
       "is_quick_debt": true,
       "sub_amounts": [756000, 1118000, 390000],
       "items": [
         { "name": "Tiền hàng", "quantity": null, "price": 2264000, "amount": 2264000 }
       ]
   - CÁC TRƯỜNG HỢP KHÁC:
     * Trường hợp hóa đơn có số tiền ở cột "Thành tiền" của từng món: lấy amount = số tiền ở cột Thành tiền * 1000.
     * Trường hợp hóa đơn chỉ có duy nhất 1 con số tổng cộng ở đáy (ví dụ "1146" hay "3814"): trả về 1 dòng "Thịt lẻ" với price = amount = tổng tiền * 1000, quantity = 1.
     * Trường hợp hóa đơn ghi rõ số kg thập phân (ví dụ "5,2" hoặc "1,95") và đơn giá thông thường: tính amount = Math.round(quantity * price).

3. TÊN KHÁCH HÀNG & NGÀY THÁNG:
   - Tên khách hàng: Thường nằm ở dòng "Tên khách hàng:" (ví dụ: "A Thang", "Yến Mễ Trì", "Lam nghi"...). Hãy so khớp với danh sách khách hàng quen thuộc ở trên. Nếu không rõ, trả về null.
   - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN BIỆT CHỮ VIẾT TAY "phở Tưởng" VÀ "phở Tiến":
     + Chữ viết tay "phở Tưởng" trên tích kê của cửa hàng rất thường xuyên bị AI nhìn lướt qua đọc nhầm thành "Phở Tiến".
     + BẮT BUỘC quan sát 4 đặc trưng thị giác then chốt sau để nhận diện chính xác "phở Tưởng":
       1) KÝ TỰ KẾT THÚC LÀ CHỮ "g" (CÓ ĐUÔI SỔ THÒNG SÂU XUỐNG DƯỚI DÒNG KẺ): Chữ cái cuối cùng có vòng tròn khép kín ở trên và một nét đuôi sổ cong thòng sâu xuống dưới dòng kẻ chấm rồi móc lượn sang phải. Đây chính là chữ "g" của "Tưởng" (T-ư-ơ-n-g). Tuyệt đối KHÔNG PHẢI chữ "n" (chữ "n" của "Tiến" kết thúc nằm hoàn toàn trên dòng kẻ, không có đuôi thòng xuống dưới).
       2) CỤM CHỮ DÀI HƠN HẲN (CỤM 5 KÝ TỰ T-ư-ơ-n-g): Sau chữ T hoa là chuỗi nhịp sóng uốn lượn liên tiếp của cụm "ươn" (nét nhô lên hạ xuống của "ư-ơ", nét cầu của "n", rồi mới đến vòng tròn của "g"). Chuỗi chữ này dài hơn hẳn chữ "Tiến" (chỉ có 3 chữ cái ngắn i-ê-n).
       3) DẤU PHỤ PHÍA TRÊN LÀ DẤU HỎI UỐN LƯỢN VÀ MÓC RÂU, KHÔNG PHẢI MŨ "ê" VÀ DẤU SẮC: Phía trên thân chữ là nét móc mềm mại của dấu hỏi "?" và móc râu của "ư/ơ". Hoàn toàn KHÔNG CÓ dấu mũ nhọn "^" của chữ "ê" và KHÔNG CÓ nét gạch chéo dứt khoát "/" của dấu sắc.
       4) NÉT CHỮ T HOA UỐN LƯỢN NỐI NÉT: Chữ "T" viết hoa thảo lượn sóng ngang ở trên rồi sổ xuống nối liền sang cụm "ươn", nét uốn ngang trên đầu này KHÔNG PHẢI dấu sắc.
     => BẤT CỨ KHI NÀO thấy chữ viết tay có nét đuôi chữ "g" thòng sâu xuống dưới dòng kẻ như trên: BẮT BUỘC trả về customer_name là "Phở Tưởng" (để khớp với khách "Phởtưởng" hoặc "Phở tưởng(chị Luyến)" trong danh bạ), TUYỆT ĐỐI CẤM đọc thành "Phở Tiến".
   - QUY TẮC ĐẶC BIỆT CHO KHÁCH "CÔ THẢO (THẦY)":
     + Nếu tên khách hàng ghi là "Thầy", "thầy", "Cô Thảo", "cô thảo", "Thảo", "cô Thảo thầy": BẮT BUỘC trả về customer_name là "Cô thảo(thầy)".
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN TÍCH NÉT CHỮ NHẬN DIỆN KHÁCH "Bún huế văn khê":
      + Quan sát nét chữ viết tay ở dòng Tên khách hàng / dưới tiêu đề "HÓA ĐƠN BÁN HÀNG":
        1) Từ "bun" (hoặc "bún"): Chữ "b" có nét sổ thẳng đứng vươn rất cao vượt lên sát chữ in "HÓA ĐƠN" phía trên, sau đó vòng nét bụng tròn ở chân dòng rồi nối liền sang cụm "un" uốn lượn sóng mềm mại.
        2) Từ "Hue" (hoặc "Huế"): Chữ "H" nét sổ cao đứng, gạch ngang nối sang chữ "u" rồi nối tiếp chữ "e" đuôi mở cong tròn, có dấu sắc hoặc phụ nhẹ trên đầu.
        3) Từ "Van" (hoặc "Văn"): Chữ "V" hoa sổ nhọn đáy rồi hất vươn lên, nối tiếp nét "an" (hoặc "ăn") viết thảo lượn sóng.
        4) Từ "Khe" (hoặc "Khê"): Chữ "K" nét sổ cao đứng, hai nét xiên chụm nối liền sang chữ "h" và "e" (hoặc "ê"), nằm sát lấn vào chữ in "ĐT:".
      + QUY TẮC QUAN TRỌNG: Bất kể trên tích kê người viết ghi đầy đủ "bun Hue Van Khe" hay CHỈ VIẾT TẮT LÀ "bún huế" (hoặc "bun Hue", "Bún Huế", "bún bò huế"):
      => BẮT BUỘC nhận diện và trả về customer_name là: "Bún huế văn khê" (hoặc so khớp với khách Bún Huế Văn Khê trong danh bạ), TUYỆT ĐỐI KHÔNG để sót hoặc nhầm sang khách khác.
    - QUY TẮC ĐẶC BIỆT CHO CÁC BẾP (B1, B2, B3, B4):
      + Chữ viết tắt "b1", "B1", "B 1", "bếp 1", "bep 1": BẮT BUỘC trả về customer_name là: "Bếp hàng xóm 1".
      + Chữ viết tắt "b2", "B2", "B 2", "bếp 2", "bep 2": BẮT BUỘC trả về customer_name là: "Bếp hàng xóm 2".
      + Chữ viết tắt "b3", "B3", "B 3", "bếp 3", "bep 3": BẮT BUỘC trả về customer_name là: "Bếp hàng xóm 3".
      + Chữ viết tắt "b4", "B4", "B 4", "bếp 4", "bep 4", "vườn xanh", "nhà hàng vườn xanh": BẮT BUỘC trả về customer_name là: "Nhà hàng vườn xanh".
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "HUYỀN ĐÔ NGHĨA" (CHỈ QUAN TÂM CON SỐ CUỐI CÙNG Ở ĐÁY):
      + Tên khách hàng: Khi ở dòng Tên khách hàng chỉ ghi chữ "Huyền" (hoặc "Huyen", "chị Huyền", "huyền đô nghĩa", "Huyền Đô Ngĩa"):
        BẮT BUỘC nhận diện customer_name là: "Huyền Đô Nghĩa" (hoặc so khớp với khách hàng có chữ "Huyền" và "Đô Nghĩa" trong danh bạ).
      + Quy tắc bóc tách số tiền: Hóa đơn của khách này không viết theo quy tắc số cân / đơn giá thông thường, CHỈ QUAN TÂM CON SỐ CUỐI CÙNG Ở ĐÁY HÓA ĐƠN.
        HÃY TÌM CON SỐ CUỐI CÙNG NẰM Ở ĐÁY HÓA ĐƠN (thường nằm dưới cùng nhất, dưới nét gạch ngang khóa sổ hoặc chỗ chữ "Người nhận hàng", ví dụ số viết tay rất to như "3814"):
        * Con số cuối cùng này chính là TỔNG SỐ TIỀN CẦN NHẬP NHANH của toàn bộ hóa đơn (đơn vị nghìn đồng, nhân với 1000). Ví dụ: "3814" -> 3814000 (3 triệu 814 nghìn đồng).
        * Trả về items gồm 1 dòng bóc tách nhanh duy nhất:
          {
            "name": "Thịt lẻ",
            "quantity": 1,
            "price": 3814000,
            "amount": 3814000
          }
          (price và amount chính là con số cuối cùng đó nhân 1000, quantity để 1).
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "THĂN BÌNH ĐÀ" / "ANH NGHĨA":
      + Nếu trên hóa đơn ghi "anh nghĩa", "anh ngĩa", "nghĩa", "ngĩa", "bình đà", "thăn bình đà":
      + BẮT BUỘC nhận diện customer_name là: "Thăn bình đà(anh Nghĩa)" (hoặc "Thăn bình đà").
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN TÍCH NÉT CHỮ KHÁCH "BÀ LƯU":
      + Quan sát nét chữ viết tay ở dòng "Tên khách hàng:" (nằm trên dòng kẻ chấm ngay dưới chữ in đỏ "HÓA ĐƠN BÁN"):
        1) Chữ thứ 1: Chữ "b" có nét sổ thẳng đứng vươn CỰC KỲ CAO đâm thẳng lên qua chữ in "Đ" của "HÓA ĐƠN", bụng dưới chữ "b" bo tròn rồi nối liền mạch không nhấc bút sang chữ "a" thảo tròn nhỏ -> tạo thành chữ "ba" (Bà).
        2) Chữ thứ 2: Chữ "l" có nét sổ thẳng vươn rất cao lên chạm sát chân chữ in "N" của "HÓA ĐƠN" (chiều cao ngang ngửa chữ "b"). Theo sau chữ "l" là 2 nét uốn cong lòng máng liên tiếp tạo thành vần "uu" / "ưu", đỉnh trên bên phải có nét móc cong nhỏ tạo thành chữ "luu" / "lưu" (hoặc "lựu").
        3) Các trường hợp AI / OCR thường bị nhìn nhầm: Do nét chữ thảo phóng khoáng, AI rất dễ đọc nhầm chữ này thành "ba linh", "ba liu", "ba lui", "ba lieu", "ba lu", "ba lựu", "ba lúc", "ba luc", "ba lù".
      + BẮT BUỘC: Khi chữ viết tay ở dòng Tên khách hàng nhìn giống "ba luu", "bà lưu", "ba liu", "ba linh", "ba lui", "ba lieu", "ba lu", "ba lựu", "ba lúc", "Lưu", "Lựu", "ba-luu", "ba lu'u":
      => BẮT BUỘC nhận diện và trả về customer_name là: "Bà lưu" (để hệ thống khớp chính xác vào khách "Bà lưu" trong danh bạ).
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN TÍCH NÉT CHỮ KHÁCH "NGUYỄN KHUYẾN TRƯỜNG HOÀNG":
      + Quan sát nét chữ viết tay ở khu vực Tên khách hàng (dưới tiêu đề in đỏ "HÓA ĐƠN BÁN HÀNG"):
        1) Dòng trên ghi chữ "Nguyễn Khuyến" (chữ "N" hoa nét thảo, "Guyển", rồi "Khuyến" - chữ "K" hoa vươn cao, "huyến" có dấu sắc).
        2) Dòng dưới (ngay dưới dòng 1) ghi chữ "trường Hoàng" (hoặc viết tắt/thảo "trg Hoàng", "Hoang", "Hoàng" với chữ "H" in hoa to, nét "oang" đuôi "g" thòng xuống).
      + QUY TẮC BẮT BUỘC: Bất kể khi nào đọc được chữ "Nguyễn" đi kèm chữ "Hoàng" (hoặc "Nguyễn . Hoàng", "nguyễn hoàng", "nguyễn khuyến", "khuyến hoàng", "nguyễn khuyến hoàng", "trường hoàng", "nguyễn trường hoàng"):
      => BẮT BUỘC nhận diện và trả về customer_name là: "Nguyễn khuyến trường hoàng" (để hệ thống khớp chính xác vào khách "Nguyễn khuyến trường hoàng" trong danh bạ).
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "52 TRẦN THÁI TÔNG":
      + Quan sát nét chữ viết tay ở dòng "Tên khách hàng:":
        Người viết ghi số "52" kèm chữ thảo "Tran Thai Tong" (chữ T hoa nét lượn, đuôi g dài) hoặc người viết CHỈ GHI TẮT CON SỐ "52" (hoặc "52 tran", "52 thai tong"):
      + BẤT KỂ KHI NÀO quét được số "52" ở dòng Tên khách hàng (hoặc ghi tắt "52"):
      + BẮT BUỘC nhận diện và trả về customer_name là: "52  trần thái tông".
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN TÍCH NÉT CHỮ KHÁCH "MINH TRANG":
      + Quan sát nét chữ viết tay ở dòng "Tên khách hàng:":
        1) Chữ thứ 1: Chữ "M" hoa nét sổ vươn rất cao sát chữ in "HÓA ĐƠN", các nét nhọn vươn cao rồi nối liền sang nét cong chữ "h" (viết tắt hoặc nhìn như "Mih" / "Minh").
        2) Chữ thứ 2: Chữ "t" có nét gạch ngang nhẹ, các nét lượn sóng và nét đuôi sổ thòng sâu xuống dưới dòng kẻ chấm (nhìn lướt qua rất dễ nhầm thành "tuy", "trag", "tray" hoặc "trang").
      + QUY TẮC BẮT BUỘC: Thường chỉ cần đọc được chữ "minh" (hoặc "mih", "Mih", "Mih tuy", "Minh tuy", "Minh trang"):
      => BẮT BUỘC nhận diện và trả về customer_name là: "Minh trang" (để so khớp với khách Minh trang trong danh bạ).
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN TÍCH NÉT CHỮ KHÁCH "TRUNG KÍNH":
      + Quan sát nét chữ viết tay ở dòng "Tên khách hàng:":
        1) Chữ thứ 1: Chữ "T" viết hoa thư pháp nét lượn sóng uốn cong, nối sang nét cong và đuôi sổ thòng rất sâu xuống dưới dòng kẻ chấm (nhìn lướt qua rất dễ đọc nhầm thành "Tuy", "Tug", "Tung", "Tay", "Túy", "Truy"). Thực chất đây là chữ "Trung" (hoặc viết thảo "Trg", "Tung").
        2) Chữ thứ 2: Chữ "k" có nét sổ vươn cực cao lên tận chân dòng in "HÓA ĐƠN BÁN HÀNG" phía trên, theo sau là nét móc ngoáy viết tắt (nhìn lướt qua rất dễ đọc nhầm thành "kh", "khs", "ks", "k's", "kb", "kl", "hh"). Thực chất đây là chữ "Kính" (hoặc viết tắt "kh" = Kính).
      + QUY TẮC BẮT BUỘC: Khi chữ viết tay ở dòng Tên khách hàng nhìn giống "Tuy kh", "Tuy khs", "Tuy ks", "Tug kh", "Tung kh", "Truy kh", "Trung kh", "Trung kinh", "trung kính", "T-kh":
      => BẮT BUỘC nhận diện và trả về customer_name là: "Trung kính" (để hệ thống khớp chính xác vào khách "Bếp trung kính (zalo loantt)" hoặc "Trungkinh").
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN TÍCH NÉT CHỮ KHÁCH "THÁI HÀ":
      + Quan sát nét chữ viết tay ở dòng "Tên khách hàng:":
        1) Chữ thứ 1: Chữ "T" viết hoa thảo lượn sóng ngang trên đầu rồi uốn lượn xuống nối liền sang chữ "h" (nhìn lướt qua rất dễ bị đọc nhầm thành "Hk", "Hkú", "Hkui", "Hki", "Hkai", "Hai", "Hải", "Thai"). Phía trên chữ "a/i" có nét dấu sắc "/" dứt khoát -> chữ "Thái" (hoặc "Thai").
        2) Chữ thứ 2: Chữ "H" viết hoa hai nét đứng song song có nét gạch ngang mềm mại nối giữa, chữ "a" tròn nhỏ có dấu huyền "\" phía trên -> chữ "Hà" (hoặc "Ha").
      + QUY TẮC BẮT BUỘC: Khi chữ viết tay ở dòng Tên khách hàng nhìn giống "Thái Hà", "Thai Ha", "thai ha", "thái hà", "Hkú Hà", "Hkú Ha", "Hki Ha", "Hkui Ha", "Hkai Ha", "Hai Ha", "Hải Hà", "Thki Ha":
      => BẮT BUỘC nhận diện và trả về customer_name là: "Thái hà" (để so khớp chính xác với khách hàng "Thái hà" trong danh bạ).
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "HÀ TRÌ" (PHÂN BIỆT VỚI "CHỊ HẠNH SÂN BÓNG HÀ TRÌ" VÀ "CỒ HẢI"):
      + Khi trên tích kê / hóa đơn ghi chữ "Hà Trì", "Hà trì", "cô Hà Trì", "cô hà trì", "Hà tri", "ha tri", "cô Trì":
      + BẮT BUỘC nhận diện và trả về customer_name là: "Hà Trì". TUYỆT ĐỐI KHÔNG nhầm sang "Chị hạnh sân bóng hà trì" (trừ khi có ghi rõ chữ "Hạnh" hoặc "chị Hạnh") và TUYỆT ĐỐI KHÔNG nhầm sang "Cồ Hải".
    - QUY TẮC ĐẶC BIỆT CHO KHÁCH "CỒ HẢI" / "CỔ HẢI":
      + Khi trên tích kê / hóa đơn ghi chữ "Cồ Hải", "cồ hải", "Cổ Hải", "cổ hải", "Cồ hải", "quán Cồ Hải":
      + BẮT BUỘC nhận diện và trả về customer_name là: "Cồ hải" (hoặc "Cồ Hải"). TUYỆT ĐỐI KHÔNG nhầm sang "Hà Trì"!
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN TÍCH NÉT CHỮ KHÁCH "GIẢNG VÕ" / "GIANG VÕ":
      + Quan sát nét chữ viết tay ở dòng "Tên khách hàng:" (dưới tiêu đề in đỏ "HÓA ĐƠN BÁN HÀNG"):
        1) Chữ thứ 1: Chữ "G" viết hoa nét cong to rộng phóng khoáng, thân nối liền vần "i-a-n", và chữ "g" cuối có nét móc đuôi sổ thòng rất sâu xuống dưới dòng kẻ chấm -> tạo thành chữ "Giang" (hoặc "Giảng").
        2) Chữ thứ 2: Chữ "V" viết hoa/thảo nét sổ cong xuống rồi uốn lượn móc hất lên bên phải nối liền mạch sang chữ "o" (hoặc "õ" có nét ngã nhẹ trên đầu) -> tạo thành chữ "Võ" (hoặc "võ").
        3) NGUYÊN NHÂN AI HAY NHÌN NHẦM: Do chữ "V" viết thảo nối liền mạch sang chữ "o", nét sổ cong trái và nét móc phải của chữ "V" khi dính liền vào chữ "o" rất dễ khiến AI OCR bị ảo giác nhìn nhầm thành chữ "Đ", "đ", "D" -> đọc sai thành "Giang Đỏ", "Giang đỏ", "Giang Đô", "Giang đô", "Giang Dỏ", "Giang dỏ", "Giang đo", "Giang do".
      + QUY TẮC BẮT BUỘC: Khi chữ viết tay ở dòng Tên khách hàng nhìn giống "Giang Võ", "Giang võ", "Giảng võ", "Giang Đỏ", "Giang đỏ", "Giang Đô", "Giang đô", "Giang Dỏ", "Giang dỏ", "Giang do", "Giang đo":
      => BẮT BUỘC nhận diện và trả về customer_name là: "Giảng võ" (để hệ thống tự động chọn chính xác khách hàng "Giảng võ" trong danh bạ).
    - QUY TẮC ĐẶC BIỆT CỐT LÕI - PHÂN BIỆT SỐ "794 LÁNG HẠ" VỚI CHỮ "CUỐN LÁNG HẠ":
      + Quan sát nét chữ viết tay ở dòng "Tên khách hàng:" (dưới tiêu đề in đỏ "HÓA ĐƠN BÁN HÀNG"):
        1) KÝ TỰ BẮT ĐẦU LÀ 3 CON SỐ "794" (KHÔNG PHẢI CHỮ VIẾT "CUỐN"):
           - Số "7": Nét ngang trên đầu hơi lượn nhẹ, nét sổ chéo xuống dưới.
           - Số "9": Vòng tròn khép kín ở trên, thân cong sổ xuống dưới.
           - Số "4": Nét sổ xiên gập ngang và nét sổ thẳng dọc cắt ngang qua.
        2) CỤM CHỮ TIẾP THEO LÀ "lang ha" (hoặc "láng hạ", "láng"):
           - Chữ "l" có nét khuyết vươn cao, chữ "a-n-g" với đuôi chữ "g" thòng sâu xuống dưới dòng kẻ, theo sau là chữ "h-a" (hoặc "hạ").
        3) NGUYÊN NHÂN AI THƯỜNG BỊ ẢO GIÁC NHÌN NHẦM THÀNH "Cuốn láng hạ":
           - Khi 3 con số "794" viết liền tay, nét lượn số 7 giống nét cong chữ "C", số 9 tròn và số 4 gập ngang giống vần "u-ố-n".
           - Đồng thời do trong danh bạ cửa hàng có khách "Cuốn láng hạ", AI bị tâm lý "ép từ điển" nhìn thấy "lang ha" liền tự động đoán sai thành "Cuốn láng hạ".
      + QUY TẮC BẮT BUỘC: Khi ở dòng Tên khách hàng nhìn thấy 3 con số "794" (hoặc "794 lang ha", "794 láng hạ", "794 đường láng", "794 lang"):
      => BẮT BUỘC nhận diện và trả về customer_name là: "794 láng hạ" (hoặc so khớp với "the industree(794 đường láng)").
      => TUYỆT ĐỐI CẤM NHẬN DIỆN THÀNH "Cuốn láng hạ"!
      => CHỈ KHI NÀO chữ đầu tiên viết tay rõ ràng bằng chữ cái "Cuốn", "Cuon", "Cươn" (hoàn toàn không có chữ số 794) thì mới là khách "Cuốn láng hạ".
    - Ngày hóa đơn: Đọc ở dòng góc dưới "Ngày [ngày] tháng [tháng] năm 20[năm]" (ví dụ: "16/09/2026").
    - Bỏ qua các nét gạch chéo, nét cong sổ dài khóa hóa đơn, không nhận nhầm thành chữ số.
4. QUY TẮC ĐẶC BIỆT XÁC ĐỊNH ĐƠN TRẢ HÀNG (CỰC KỲ QUAN TRỌNG):
   - Khi trên tờ hóa đơn / tích kê có chữ viết tay: "trả", "trả lại", "trả hàng", "gửi về", "trả về", "gửi lại", "hàng trả", "thu hồi", "quay đầu" (hoặc có dấu trừ "-" trước số tiền hoặc số cân):
   - BẮT BUỘC nhận diện đây là ĐƠN TRẢ HÀNG (khách gửi trả hàng để giảm trừ nợ, KHÔNG phải đơn mua mới):
     + BẮT BUỘC đặt "is_return": true (đơn bán bình thường là false).
     + BẮT BUỘC đặt "note": "[Trả lại hàng]".
     + Vẫn bóc tách chính xác customer_name và danh sách các món thịt (name, quantity, price, amount).
     + TUYỆT ĐỐI CẤM đưa các chữ "trả", "trả hàng", "gửi về", "trả về", "trả lại", "hàng trả" vào tên khách hàng hay tên món thịt!

Chỉ trả về JSON theo đúng cấu trúc:
{
  "is_valid_invoice": true,
  "customer_name": "Tên khách hàng hoặc null",
  "invoice_date": "DD/MM/YYYY hoặc null",
  "is_return": false,
  "note": "Ghi chú nếu có (hoặc '[Trả lại hàng]' nếu là đơn trả)",
  "items": [
    {
      "name": "Xg Bò / Tái (Bò) / Bắp Bò / Gầu Bò / Sườn...",
      "quantity": 11.4,
      "price": 250000,
      "amount": 2850000
    }
  ]
}
(NẾU ẢNH LÀ GIẤY NHÁP / MẶT SAU / KHÔNG CÓ BỐ CỤC HÓA ĐƠN BÁN HÀNG: đặt "is_valid_invoice": false, "items": [], "customer_name": null)`;
    }

    // 5. Gọi Gemini API
    const geminiResult = await callGeminiWithRetry({
      apiKey: process.env.GEMINI_API_KEY,
      contents: [
        {
          parts: [
            { text: promptText },
            {
              inlineData: {
                mimeType: filePayload.mimeType,
                data: filePayload.base64Data,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseSchema: {
          type: 'OBJECT',
          properties: {
            is_valid_invoice: { type: 'BOOLEAN', nullable: true },
            customer_name: { type: 'STRING', nullable: true },
            invoice_date: { type: 'STRING', nullable: true },
            is_return: { type: 'BOOLEAN', nullable: true },
            note: { type: 'STRING', nullable: true },
            items: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  quantity: { type: 'NUMBER' },
                  price: { type: 'NUMBER', nullable: true },
                  amount: { type: 'NUMBER', nullable: true },
                },
                required: ['name', 'quantity'],
              },
            },
          },
          required: ['items'],
        },
      },
    });

    const parsedJson = JSON.parse(geminiResult.text.trim() || '{}');
    // Kiểm tra xem ảnh có bố cục của một hóa đơn bán hàng hợp lệ không
    const isValidInvoice = isVideo || parsedJson.is_valid_invoice !== false;
    const rawItems = (isValidInvoice && Array.isArray(parsedJson.items)) ? parsedJson.items : [];
    const isQuickDebtParsed = Boolean(
      parsedJson.is_quick_debt === true ||
      (Array.isArray(parsedJson.sub_amounts) && parsedJson.sub_amounts.length > 0) ||
      (rawItems.length > 0 && rawItems.every((it) => {
        const cName = (it.name || '').toLowerCase().trim();
        return (!cName || cName === 'thịt lẻ' || cName === 'thit le' || cName === 'tiền hàng' || cName === 'tien hang') && (!it.quantity || parseFloat(it.quantity) <= 0);
      }))
    );
    if (isQuickDebtParsed) {
      parsedJson.is_quick_debt = true;
    }
    const detectedCustomerName = isValidInvoice ? (parsedJson.customer_name || null) : null;
    let aiErrorMsg = (!isVideo && !isValidInvoice)
      ? (parsedJson.note || 'Ảnh không có bố cục của một hóa đơn bán hàng (giấy nháp/mặt sau), AI đã bỏ qua không quét.')
      : null;

    // Nhận diện đơn trả hàng (khi khách đọc hoặc viết: gửi về, trả hàng, trả về, trả lại, gửi lại, hàng trả, thu hồi, quay đầu, đổi trả, hoàn hàng...)
    const returnRegex = /(trả hàng|gửi về|trả về|trả lại|gửi lại|hàng trả|thu hồi|bắn về|quay đầu|đổi trả|hoàn hàng|tra hang|gui ve|tra ve|tra lai|gui lai|hang tra|quay dau|doi tra|hoan hang)/i;
    const isReturnOrder = isValidInvoice && Boolean(
      parsedJson.is_return === true ||
      (parsedJson.note && returnRegex.test(parsedJson.note)) ||
      (submission.note && returnRegex.test(submission.note)) ||
      (detectedCustomerName && returnRegex.test(detectedCustomerName)) ||
      rawItems.some((it) => returnRegex.test(it.name || '')) ||
      returnRegex.test(geminiResult.text || '')
    );

    if (isReturnOrder) {
      parsedJson.is_return = true;
    }

    // Làm sạch tên khách hàng nếu dính các từ khóa trả hàng (ví dụ "Thái Hà trả về", "Gửi lại Cô Thảo", "Trả hàng anh Thắng"...)
    let cleanDetectedCustomerName = detectedCustomerName;
    if (cleanDetectedCustomerName && isReturnOrder) {
      cleanDetectedCustomerName = cleanDetectedCustomerName
        .replace(/\b(trả hàng|gửi về|trả về|trả lại|gửi lại|hàng trả|thu hồi|bắn về|quay đầu|đổi trả|hoàn hàng|tra hang|gui ve|tra ve|tra lai|gui lai|hang tra|quay dau|doi tra|hoan hang|trả|tra)\b/gi, '')
        .replace(/[-–—:()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Chuẩn bị note của submission
    let submissionNote = submission.note || '';
    if (!isValidInvoice) {
      submissionNote = '[Không phải hóa đơn] Giấy nháp / Mặt sau';
    } else if (isReturnOrder) {
      if (!submissionNote.includes('[Trả lại hàng]') && !submissionNote.includes('[Trả hàng]')) {
        const extraNote = parsedJson.note && !parsedJson.note.includes('[Trả lại hàng]') ? parsedJson.note : '';
        submissionNote = submissionNote
          ? `[Trả lại hàng] ${submissionNote}${extraNote ? ` - ${extraNote}` : ''}`
          : (extraNote ? `[Trả lại hàng] ${extraNote}` : '[Trả lại hàng]');
      }
    }

    // 6. Giữ nguyên ngày nộp hiện tại của submission (không chia ra từng ngày theo hóa đơn giấy)
    const submissionDate = submission.date || new Date();
    if (parsedJson.invoice_date) {
      // Ghi chú ngày trên hóa đơn để tham khảo, không đổi ngày submission để hiển thị chung ở giao diện ngày hiện tại
      const invoiceDateStr = String(parsedJson.invoice_date).trim();
      if (invoiceDateStr && !submissionNote.includes(invoiceDateStr)) {
        submissionNote = submissionNote ? `${submissionNote} (HĐ: ${invoiceDateStr})` : `(HĐ: ${invoiceDateStr})`;
      }
    }

    // 7. So khớp khách hàng với danh bạ (dùng cleanDetectedCustomerName để loại bỏ từ khóa trả hàng)
    let matchedCustomerId = null;
    const customerNameToMatch = cleanDetectedCustomerName || detectedCustomerName;
    if (customerNameToMatch) {
      const cleanDetected = removeDiacritics(customerNameToMatch.toLowerCase().trim());
      const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

      // Ưu tiên khớp khách Cô thảo(thầy) nếu AI nhận diện là thầy hoặc cô thảo
      if (
        cleanDetectedNoSpace === 'thay' ||
        cleanDetectedNoSpace === 'cothao' ||
        cleanDetectedNoSpace === 'thao' ||
        cleanDetected.includes('thay') ||
        cleanDetected.includes('thao')
      ) {
        const coThaoCust = customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase());
          return cClean.includes('thao') && cClean.includes('thay');
        }) || customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase());
          return cClean.includes('thao');
        });
        if (coThaoCust) {
          matchedCustomerId = coThaoCust.id;
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách Tuyết nếu AI nhận diện có chứa chữ "tuyet"
        if (cleanDetected.includes('tuyet') || cleanDetectedNoSpace.includes('tuyet')) {
          const tuyetCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('tuyet');
          });
          if (tuyetCust) {
            matchedCustomerId = tuyetCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Minh trang" nếu AI nhận diện là minh, mih, minh trang, mih tuy...
        if (
          cleanDetected.includes('minh trang') ||
          cleanDetected.includes('mih trang') ||
          cleanDetected.includes('minh tuy') ||
          cleanDetected.includes('mih tuy') ||
          cleanDetected.includes('mih') ||
          cleanDetectedNoSpace === 'minh' ||
          cleanDetectedNoSpace === 'mih' ||
          cleanDetectedNoSpace.includes('minhtrang') ||
          cleanDetectedNoSpace.includes('mihtrang') ||
          cleanDetectedNoSpace.includes('mihtuy') ||
          cleanDetectedNoSpace.includes('minhtuy')
        ) {
          const minhTrangCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('minh') && cClean.includes('trang');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'minh trang';
          });
          if (minhTrangCust) {
            matchedCustomerId = minhTrangCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Trung kính" / "Bếp trung kính" nếu AI nhận diện là trung kính, trung kh, tuy kh, tug kh...
        if (
          cleanDetected.includes('trung kinh') ||
          cleanDetected.includes('bep trung kinh') ||
          cleanDetected.includes('trung kh') ||
          cleanDetected.includes('tuy kh') ||
          cleanDetected.includes('tuy ks') ||
          cleanDetected.includes('tug kh') ||
          cleanDetected.includes('tung kh') ||
          cleanDetected.includes('truy kh') ||
          cleanDetectedNoSpace === 'trungkinh' ||
          cleanDetectedNoSpace === 'tuykh' ||
          cleanDetectedNoSpace === 'tuykhs' ||
          cleanDetectedNoSpace === 'tuyks' ||
          cleanDetectedNoSpace === 'tugkh' ||
          cleanDetectedNoSpace === 'tungkh' ||
          cleanDetectedNoSpace === 'truykh' ||
          cleanDetectedNoSpace.includes('trungkinh') ||
          cleanDetectedNoSpace.includes('beptrungkinh')
        ) {
          // Ưu tiên khách có chứa "bep trung kinh" hoặc "trung kinh" (ví dụ: Bếp trung kính (zalo loantt) hoặc Trungkinh)
          const trungKinhCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('bep trung kinh') || (cClean.includes('trung') && cClean.includes('kinh'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('trung kinh') || cClean === 'trungkinh';
          });
          if (trungKinhCust) {
            matchedCustomerId = trungKinhCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Thái hà" nếu AI nhận diện là thái hà, thai ha, hku ha, hki ha, hai ha...
        if (
          cleanDetected.includes('thai ha') ||
          cleanDetected.includes('thái hà') ||
          cleanDetectedNoSpace.includes('thaiha') ||
          cleanDetected.includes('hku ha') ||
          cleanDetectedNoSpace.includes('hkuha') ||
          cleanDetected.includes('hki ha') ||
          cleanDetectedNoSpace.includes('hkiha') ||
          cleanDetected.includes('hkui ha') ||
          cleanDetectedNoSpace.includes('hkuiha') ||
          cleanDetected.includes('hkai ha') ||
          cleanDetectedNoSpace.includes('hkaiha') ||
          cleanDetected.includes('thki ha') ||
          cleanDetectedNoSpace.includes('thkiha') ||
          cleanDetected.includes('hai ha') ||
          cleanDetectedNoSpace.includes('haiha')
        ) {
          const thaiHaCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'thai ha' || (cClean.includes('thai') && cClean.includes('ha') && !cClean.includes('ngoc lam'));
          });
          if (thaiHaCust) {
            matchedCustomerId = thaiHaCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Anh thắng phố cổ" nếu AI nhận diện là A Thang, A Thắng, ATHang, thang pho co...
        if (
          cleanDetected === 'a thang' ||
          cleanDetected === 'athang' ||
          cleanDetected === 'a.thang' ||
          cleanDetected === 'anh thang' ||
          cleanDetectedNoSpace === 'athang' ||
          cleanDetectedNoSpace === 'anhthang' ||
          cleanDetected.includes('thang pho co') ||
          cleanDetectedNoSpace.includes('thangphoco') ||
          (cleanDetected.includes('thang') && !cleanDetected.includes('chu tu'))
        ) {
          const thangPhoCoCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('thang') && cClean.includes('pho co');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'anh thang pho co';
          });
          if (thangPhoCoCust) {
            matchedCustomerId = thangPhoCoCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Phở đông" nếu AI nhận diện là phở đg, phở đông, pho dg, pho dong...
        if (
          cleanDetected === 'pho dg' ||
          cleanDetected === 'phodg' ||
          cleanDetected === 'pho dong' ||
          cleanDetected === 'phodong' ||
          cleanDetected === 'dg' ||
          cleanDetectedNoSpace === 'phodg' ||
          cleanDetectedNoSpace === 'phodong' ||
          (cleanDetected.includes('pho') && (cleanDetected.includes('dg') || cleanDetected.includes('dong'))) ||
          cleanDetected.includes('pho dong')
        ) {
          const phoDongCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'pho dong' || (cClean.includes('pho') && cClean.includes('dong'));
          });
          if (phoDongCust) {
            matchedCustomerId = phoDongCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Gia Hưng cs2" nếu AI nhận diện là Gia Hy CS2, Gia Hưng CS2, Gia Hưng 2...
        const isGiaHungCs2 = (cleanDetected.includes('gia') && (cleanDetected.includes('hung') || cleanDetected.includes('hy')) && (cleanDetected.includes('cs2') || cleanDetected.includes('cs 2') || cleanDetected.includes('co so 2') || cleanDetected.endsWith('2'))) ||
          cleanDetectedNoSpace.includes('giahycs2') ||
          cleanDetectedNoSpace.includes('giahungcs2') ||
          cleanDetected.includes('gia hy cs2') ||
          cleanDetected.includes('gia hung cs2');

        if (isGiaHungCs2) {
          const giaHungCs2Cust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'gia hung cs2' || (cClean.includes('gia hung') && cClean.includes('cs2'));
          });
          if (giaHungCs2Cust) {
            matchedCustomerId = giaHungCs2Cust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Giảng võ" nếu AI nhận diện là giang vo, giang do, giang đo, giang đỏ, giang đô...
        if (
          cleanDetected.includes('giang vo') ||
          cleanDetected.includes('giang do') ||
          cleanDetected.includes('giang đô') ||
          cleanDetected.includes('giang đo') ||
          cleanDetected.includes('giang đỏ') ||
          cleanDetected.includes('giang dỏ') ||
          cleanDetected.includes('giang võ') ||
          cleanDetected.includes('giảng võ') ||
          cleanDetectedNoSpace === 'giangvo' ||
          cleanDetectedNoSpace === 'giangdo' ||
          cleanDetectedNoSpace === 'giangđo' ||
          cleanDetectedNoSpace === 'giangđỏ' ||
          cleanDetectedNoSpace === 'giangđô' ||
          cleanDetectedNoSpace.includes('giangvo') ||
          cleanDetectedNoSpace.includes('giangdo') ||
          cleanDetectedNoSpace.includes('giangđo') ||
          cleanDetectedNoSpace.includes('giangđỏ')
        ) {
          const giangVoCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'giang vo' || cClean.includes('giang vo');
          });
          if (giangVoCust) {
            matchedCustomerId = giangVoCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "the industree(794 đường láng)" / "794 láng hạ" nếu AI nhận diện có số 794 hoặc the industree
        if (
          cleanDetected.includes('794') ||
          cleanDetectedNoSpace.includes('794') ||
          cleanDetected.includes('industree') ||
          (cleanDetected.includes('lang ha') && !cleanDetected.includes('cuon') && !cleanDetected.includes('cuon lang ha'))
        ) {
          const industreeCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('794') || cClean.includes('industree');
          });
          if (industreeCust) {
            matchedCustomerId = industreeCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Phân biệt rõ khách "văn khê" và "Bún huế van khe":
        // 1) Nếu có chữ "bun hue", "bunhue", "bun bo hue", hoặc có cả "bun" và "van khe" -> Khách "Bún huế van khe"
        const hasBunHue = cleanDetected.includes('bun hue') || cleanDetected.includes('bun bo hue') ||
          cleanDetectedNoSpace.includes('bunhue') || (cleanDetected.includes('bun') && cleanDetected.includes('van khe'));

        // 2) Nếu CHỈ CÓ "van khe" hoặc "vankhe" (hoàn toàn KHÔNG có chữ "bun" hay "hue") -> Khách "văn khê"
        const isOnlyVanKhe = (cleanDetected.includes('van khe') || cleanDetectedNoSpace.includes('vankhe')) && !hasBunHue && !cleanDetected.includes('bun') && !cleanDetected.includes('hue');

        if (isOnlyVanKhe) {
          const vanKheCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'van khe' || (cClean.includes('van khe') && !cClean.includes('bun') && !cClean.includes('hue'));
          });
          if (vanKheCust) {
            matchedCustomerId = vanKheCust.id;
          }
        } else if (hasBunHue) {
          const bunHueCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('bun hue') && cClean.includes('van khe')) || (cClean.includes('bun') && cClean.includes('van khe'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('bun hue');
          });
          if (bunHueCust) {
            matchedCustomerId = bunHueCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên B1, B2, B3, B4 (Bếp hàng xóm 1, 2, 3 và Nhà hàng vườn xanh)
        if (
          cleanDetectedNoSpace === 'b1' ||
          cleanDetectedNoSpace === 'bep1' ||
          cleanDetectedNoSpace === 'bephangxom1' ||
          cleanDetected.includes('bep hang xom 1') ||
          cleanDetected.includes('truong bo 1')
        ) {
          const cust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('bep hang xom') && cClean.includes('1')) || cClean.includes('b1') || cClean.includes('bep 1');
          });
          if (cust) matchedCustomerId = cust.id;
        } else if (
          cleanDetectedNoSpace === 'b2' ||
          cleanDetectedNoSpace === 'bep2' ||
          cleanDetectedNoSpace === 'bephangxom2' ||
          cleanDetected.includes('bep hang xom 2')
        ) {
          const cust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('bep hang xom') && cClean.includes('2')) || cClean.includes('b2') || cClean.includes('bep 2');
          });
          if (cust) matchedCustomerId = cust.id;
        } else if (
          cleanDetectedNoSpace === 'b3' ||
          cleanDetectedNoSpace === 'bep3' ||
          cleanDetectedNoSpace === 'bephangxom3' ||
          cleanDetected.includes('bep hang xom 3')
        ) {
          const cust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('bep hang xom') && cClean.includes('3')) || cClean.includes('b3') || cClean.includes('bep 3');
          });
          if (cust) matchedCustomerId = cust.id;
        } else if (
          cleanDetectedNoSpace === 'b4' ||
          cleanDetectedNoSpace === 'bep4' ||
          cleanDetectedNoSpace === 'vuonxanh' ||
          cleanDetectedNoSpace === 'nhahangvuonxanh' ||
          cleanDetected.includes('vuon xanh')
        ) {
          const cust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('vuon xanh') || cClean.includes('b4') || cClean.includes('bep 4');
          });
          if (cust) matchedCustomerId = cust.id;
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Huyền Đô Nghĩa" nếu AI nhận diện là Huyền hoặc Huyền Đô Nghĩa
        if (
          cleanDetected.includes('huyen do nghia') ||
          cleanDetected.includes('huyen do ngia') ||
          cleanDetected.includes('do nghia') ||
          cleanDetectedNoSpace === 'huyen' ||
          cleanDetectedNoSpace === 'chihuyen' ||
          cleanDetected === 'huyen'
        ) {
          const huyenCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('huyen') && (cClean.includes('do nghia') || cClean.includes('do ngia'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('do nghia') || cClean.includes('do ngia');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('huyen');
          });
          if (huyenCust) {
            matchedCustomerId = huyenCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Phở tưởng (chị Luyến)" nếu AI nhận diện là phở tưởng hoặc luyến
        if (
          cleanDetected.includes('pho tuong') ||
          cleanDetected.includes('tuong') ||
          cleanDetected.includes('luyen') ||
          cleanDetectedNoSpace.includes('photuong') ||
          cleanDetectedNoSpace.includes('tuong') ||
          cleanDetectedNoSpace.includes('luyen')
        ) {
          const phoTuongCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('tuong') || cClean.includes('pho tuong')) && cClean.includes('luyen');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('tuong') && !cClean.includes('tien');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('luyen');
          });
          if (phoTuongCust) {
            matchedCustomerId = phoTuongCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Chị Thúy Nga" nếu AI nhận diện là chinga, chị nga, nga
        if (
          cleanDetected.includes('chinga') ||
          cleanDetected.includes('chi nga') ||
          cleanDetected.includes('thuy nga') ||
          cleanDetectedNoSpace.includes('chinga') ||
          cleanDetectedNoSpace.includes('thuynga') ||
          cleanDetectedNoSpace === 'nga' ||
          cleanDetected === 'nga'
        ) {
          const thuyNgaCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('thuy') && cClean.includes('nga');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('nga');
          });
          if (thuyNgaCust) {
            matchedCustomerId = thuyNgaCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Cồ Hải" (Cổ Hải) nếu AI nhận diện là cồ hải, cổ hải, co hai...
        if (
          cleanDetected.includes('co hai') ||
          cleanDetectedNoSpace.includes('cohai') ||
          cleanDetected === 'co hai' ||
          cleanDetectedNoSpace === 'cohai'
        ) {
          const coHaiCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim());
            return cClean === 'co hai' && c.isActive && !c.isBadDebt;
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim());
            return cClean === 'co hai';
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim());
            return cClean.includes('co hai');
          });
          if (coHaiCust) {
            matchedCustomerId = coHaiCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Hà Trì" nếu AI nhận diện là ha tri, ha li, ha lu, ha thi...
        if (
          cleanDetected.includes('ha tri') ||
          cleanDetected.includes('ha li') ||
          cleanDetected.includes('ha lu') ||
          cleanDetected.includes('ha thi') ||
          cleanDetectedNoSpace === 'hatri' ||
          cleanDetectedNoSpace === 'hali' ||
          cleanDetectedNoSpace === 'halu' ||
          cleanDetectedNoSpace === 'hathi' ||
          cleanDetectedNoSpace.includes('hatri')
        ) {
          const isHanh = cleanDetected.includes('hanh') || cleanDetected.includes('chi hanh');
          if (isHanh) {
            const hanhCust = customers.find((c) => {
              const cClean = removeDiacritics(c.name.toLowerCase());
              return cClean.includes('hanh');
            });
            if (hanhCust) {
              matchedCustomerId = hanhCust.id;
            }
          } else {
            // Đọc là "Hà Trì" -> ƯU TIÊN khách có tên chính xác là "Hà Trì", TUYỆT ĐỐI không nhầm sang "Chị hạnh sân bóng hà trì"
            const exactHaTriCust = customers.find((c) => {
              const cClean = removeDiacritics(c.name.toLowerCase()).trim();
              return cClean === 'ha tri';
            });
            const haTriCust = exactHaTriCust || customers.find((c) => {
              const cClean = removeDiacritics(c.name.toLowerCase());
              return cClean.includes('ha tri') && !cClean.includes('hanh');
            });
            if (haTriCust) {
              matchedCustomerId = haTriCust.id;
            }
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Thăn bình đà(anh Nghĩa)" nếu AI nhận diện là anh nghĩa, anh ngĩa, nghĩa, ngĩa, bình đà...
        if (
          cleanDetected.includes('anh nghia') ||
          cleanDetected.includes('anh ngia') ||
          cleanDetected.includes('binh da') ||
          cleanDetected.includes('than binh da') ||
          cleanDetectedNoSpace.includes('anhnghia') ||
          cleanDetectedNoSpace.includes('anhngia') ||
          cleanDetectedNoSpace === 'nghia' ||
          cleanDetectedNoSpace === 'ngia'
        ) {
          const thanBinhDaCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('binh da') && (cClean.includes('nghia') || cClean.includes('than'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('binh da');
          });
          if (thanBinhDaCust) {
            matchedCustomerId = thanBinhDaCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Bà lưu" nếu AI nhận diện là ba luu, bà lưu, luu, hoặc các nét chữ thảo dễ đọc nhầm (ba liu, ba linh, ba lui, ba lieu, ba lu, ba lúc)
        if (
          cleanDetected.includes('ba luu') ||
          cleanDetected.includes('bà lưu') ||
          cleanDetected.includes('ba liu') ||
          cleanDetected.includes('ba lui') ||
          cleanDetected.includes('ba lieu') ||
          cleanDetected.includes('ba linh') ||
          cleanDetected.includes('ba lu') ||
          cleanDetected.includes('ba luc') ||
          cleanDetectedNoSpace === 'baluu' ||
          cleanDetectedNoSpace === 'baliu' ||
          cleanDetectedNoSpace === 'balinh' ||
          cleanDetectedNoSpace === 'balui' ||
          cleanDetectedNoSpace === 'balieu' ||
          cleanDetectedNoSpace === 'balu' ||
          cleanDetectedNoSpace === 'luu' ||
          cleanDetectedNoSpace === 'liu'
        ) {
          const baLuuCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'ba luu' || cClean.includes('ba luu');
          });
          if (baLuuCust) {
            matchedCustomerId = baLuuCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Nguyễn khuyến trường hoàng"
        // Khi đọc được "nguyễn" đi kèm "hoàng", hoặc "khuyến" đi kèm "hoàng", hoặc "nguyễn khuyến", "trường hoàng"...
        const hasNguyenOrKhuyen = cleanDetected.includes('nguyen') || cleanDetected.includes('khuyen') || cleanDetectedNoSpace.includes('nguyen') || cleanDetectedNoSpace.includes('khuyen');
        const hasHoang = cleanDetected.includes('hoang') || cleanDetectedNoSpace.includes('hoang');
        const hasTruongHoang = cleanDetected.includes('truong hoang') || cleanDetectedNoSpace.includes('truonghoang');
        const hasNguyenKhuyen = cleanDetected.includes('nguyen khuyen') || cleanDetectedNoSpace.includes('nguyenkhuyen');

        if ((hasNguyenOrKhuyen && hasHoang) || (hasNguyenKhuyen && hasTruongHoang) || (hasNguyenKhuyen && hasHoang) || cleanDetected.includes('khuyen truong hoang')) {
          const nkCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('khuyen') && cClean.includes('hoang')) || (cClean.includes('nguyen') && cClean.includes('khuyen') && cClean.includes('hoang'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('khuyen') && (cClean.includes('truong') || cClean.includes('hoang'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('nguyen khuyen');
          });
          if (nkCust) {
            matchedCustomerId = nkCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "52  trần thái tông" nếu AI nhận diện là 52, 52 tran thai tong, trần thái tông...
        if (
          cleanDetected.includes('52') ||
          cleanDetectedNoSpace.includes('52') ||
          cleanDetected.includes('tran thai tong') ||
          cleanDetectedNoSpace.includes('tranthaitong')
        ) {
          if (cleanDetected.includes('52') || cleanDetectedNoSpace.includes('52') || !cleanDetected.includes('47')) {
            const cust52 = customers.find((c) => {
              const cClean = removeDiacritics(c.name.toLowerCase());
              return cClean.includes('52') && (cClean.includes('tran thai tong') || cClean.includes('thai tong') || cClean.includes('tran'));
            }) || customers.find((c) => {
              const cClean = removeDiacritics(c.name.toLowerCase());
              return cClean.includes('52');
            });
            if (cust52) {
              matchedCustomerId = cust52.id;
            }
          }
        }
      }

      if (!matchedCustomerId) {
        // 1. Ưu tiên khớp CHÍNH XÁC 100% (Exact Match) trước (Tránh trường hợp "Kcc" bị nhận nhầm sang "Kcc1")
        const exactCust = customers.find((c) => {
          const cName = removeDiacritics(c.name.toLowerCase().trim());
          const cNameNoSpace = cName.replace(/\s+/g, '');
          return cName === cleanDetected || cNameNoSpace === cleanDetectedNoSpace;
        });
        if (exactCust) {
          matchedCustomerId = exactCust.id;
        }
      }

      if (!matchedCustomerId) {
        // 2. Chỉ khi không có khách nào khớp 100% mới so khớp chứa một phần (includes)
        const sortedCusts = [...customers].sort((a, b) => b.name.length - a.name.length);
        const matchedCust = sortedCusts.find((c) => {
          const cName = removeDiacritics(c.name.toLowerCase().trim());
          const cNameNoSpace = cName.replace(/\s+/g, '');
          if (cName.length >= 3 && cleanDetected.includes(cName)) return true;
          if (cNameNoSpace.length >= 3 && cleanDetectedNoSpace.includes(cNameNoSpace)) return true;
          if (cleanDetected.length >= 3 && cName.includes(cleanDetected)) return true;
          if (cleanDetectedNoSpace.length >= 3 && cNameNoSpace.includes(cleanDetectedNoSpace)) return true;
          return false;
        });
        if (matchedCust) {
          matchedCustomerId = matchedCust.id;
        }
      }
    }

    // Lấy bảng giá riêng của khách hàng nếu đã khớp khách
    const customerPriceMap = new Map();
    if (matchedCustomerId) {
      try {
        const customPrices = await prisma.customerProductPrice.findMany({
          where: { customerId: matchedCustomerId },
        });
        customPrices.forEach((cp) => {
          if (cp.price != null) {
            customerPriceMap.set(cp.productId, parseFloat(cp.price));
          }
        });
      } catch (err) {
        console.warn('[AI_PARSER] Lỗi lấy giá riêng của khách hàng:', err);
      }
    }

    // Xử lý đặc thù cho video khách "Hương": nếu không đọc tên thịt hoặc đọc tên chung chung thì mặc định là thịt "xô", đơn giá 230k
    const cleanCustDetected = detectedCustomerName ? removeDiacritics(detectedCustomerName.toLowerCase().trim()) : '';
    const isHuongCustomer = cleanCustDetected.includes('huong') ||
      (matchedCustomerId && customers.some((c) => c.id === matchedCustomerId && removeDiacritics(c.name.toLowerCase()).includes('huong')));

    if (isVideo && isHuongCustomer) {
      rawItems.forEach((item) => {
        const itemClean = removeDiacritics((item.name || '').toLowerCase().trim());
        if (!itemClean || ['thit', 'thit bo', 'thit le', 'mon le', 'thit xo', 'xo', 'thit thai'].includes(itemClean) || itemClean.includes('xo')) {
          item.name = 'xô';
          item.price = 230000;
          if (item.quantity != null) {
            item.amount = Math.round(item.quantity * 230000);
          }
        }
      });
    }

    // Fallback thông minh cho video: Nếu có số kg nhưng tên thịt bị bỏ trống hoặc chung chung
    if (isVideo) {
      rawItems.forEach((item) => {
        const itemClean = removeDiacritics((item.name || '').toLowerCase().trim());
        if (!itemClean || ['thit', 'thit bo', 'thit le', 'mon le', 'thit thai', ''].includes(itemClean)) {
          if (customerPriceMap.size > 0) {
            const firstProdId = customerPriceMap.keys().next().value;
            const customProd = products.find((p) => p.id === firstProdId);
            if (customProd) {
              item.name = customProd.name;
              if (item.price == null) item.price = customerPriceMap.get(firstProdId);
            }
          } else if (cleanCustDetected.includes('tuyet')) {
            item.name = 'Thăn';
          } else if (cleanCustDetected.includes('hai')) {
            item.name = 'Thịt lạm';
          } else if (cleanCustDetected.includes('tuong') || cleanCustDetected.includes('luyen')) {
            item.name = 'Gầu Bò';
          } else if (cleanCustDetected.includes('nghia') || cleanCustDetected.includes('binh da')) {
            item.name = 'Thăn';
          }
        }
      });
    }

    // 8. Xóa các items cũ nếu có và thêm items mới đã so khớp sản phẩm
    await prisma.staffSubmissionItem.deleteMany({
      where: { submissionId },
    });

    // Bảng ánh xạ các từ viết tắt / từ lóng đặc thù sang tên chuẩn của chủ buôn
    const SPECIAL_MEAT_MAP = {
      'x': 'Xg Bò',
      'xg': 'Xg Bò',
      'xg bo': 'Xg Bò',
      'xuong': 'Xg Bò',
      'xuong bo': 'Xg Bò',
      'tai': 'Tái (Bò)',
      'tai bo': 'Tái (Bò)',
      'bap': 'Bắp Bò',
      'bap bo': 'Bắp Bò',
      'bắp': 'Bắp Bò',
      'bắp bò': 'Bắp Bò',
      'thit bap': 'Bắp Bò',
      'thịt bắp': 'Bắp Bò',
      'bap hoa': 'Bắp Bò',
      'bắp hoa': 'Bắp Bò',
      'qua bap': 'Bắp Bò',
      'quả bắp': 'Bắp Bò',
      'gau': 'Gầu Bò',
      'gau bo': 'Gầu Bò',
      'gâu': 'Gầu Bò',
      'gâu bò': 'Gầu Bò',
      'gầu': 'Gầu Bò',
      'gầu bò': 'Gầu Bò',
      'gầu': 'Gầu Bò',
      'gầu bò': 'Gầu Bò',
      'gou': 'Gầu Bò',
      'gou bo': 'Gầu Bò',
      'gow': 'Gầu Bò',
      'thit gau': 'Gầu Bò',
      'thịt gầu': 'Gầu Bò',
      'thit gâu': 'Gầu Bò',
      'thịt gâu': 'Gầu Bò',
      's': 'Sườn',
      'suon': 'Sườn',
      'suon bo': 'Sườn',
      // Sườn xg (xườn xg, sườn xg, sườn xương, x lơn x lơng, xldn xldug...)
      'suon xg': 'Sườn xg',
      'sườn xg': 'Sườn xg',
      'xuon xg': 'Sườn xg',
      'xườn xg': 'Sườn xg',
      'suon xuong': 'Sườn xg',
      'sườn xương': 'Sườn xg',
      'xuon xuong': 'Sườn xg',
      'xườn xương': 'Sườn xg',
      'x lon x long': 'Sườn xg',
      'x lơn x lơng': 'Sườn xg',
      'xldn xldug': 'Sườn xg',
      'xlan xg': 'Sườn xg',
      'xuan xg': 'Sườn xg',
      'xion xg': 'Sườn xg',
      'xian xg': 'Sườn xg',
      'xian xdang': 'Sườn xg',
      'x long': 'Sườn xg',
      'x lơng': 'Sườn xg',
      'xdug': 'Sườn xg',
      's xg': 'Sườn xg',
      'sườn x': 'Sườn xg',
      'suon x': 'Sườn xg',
      'x xg': 'Sườn xg',
      'sườn kg': 'Sườn xg',
      'suon kg': 'Sườn xg',
      'sườn k.g': 'Sườn xg',
      'suon k.g': 'Sườn xg',
      'sườn x.g': 'Sườn xg',
      'suon x.g': 'Sườn xg',
      'sườn xq': 'Sườn xg',
      'suon xq': 'Sườn xg',
      'scion xg': 'Sườn xg',
      'scion kg': 'Sườn xg',
      'sian xg': 'Sườn xg',
      'sian kg': 'Sườn xg',
      'sun xg': 'Sườn xg',
      'sùn xg': 'Sườn xg',
      'sùn kg': 'Sườn xg',
      'sun kg': 'Sườn xg',
      'scon xg': 'Sườn xg',
      'scòn xg': 'Sườn xg',
      'sion xg': 'Sườn xg',
      'siơn xg': 'Sườn xg',
      's kg': 'Sườn xg',
      's.kg': 'Sườn xg',
      // Ánh xạ thịt xô
      'xo': 'xô',
      'thit xo': 'xô',
      'thịt xô': 'xô',
      'xo bo': 'xô',
      // Ánh xạ thịt chín
      'chi': 'Thịt chín',
      'chí': 'Thịt chín',
      'thit chi': 'Thịt chín',
      'thịt chí': 'Thịt chín',
      'chin': 'Thịt chín',
      'thit chin': 'Thịt chín',
      'thịt chín': 'Thịt chín',
      'bo chin': 'Thịt chín',
      'bò chín': 'Thịt chín',
      // Phân biệt rõ thịt lạm và lạm gầu
      'lam gau': 'Lạm gầu',
      'lam gau bo': 'Lạm gầu',
      'lam + gau': 'Lạm gầu',
      'lam+gau': 'Lạm gầu',
      'nam gau': 'Lạm gầu',
      'lam': 'Thịt lạm',
      'thit lam': 'Thịt lạm',
      'lam bo': 'Thịt lạm',
      'nam': 'Thịt lạm',
      'thit nam': 'Thịt lạm',
      // Bò & Tiết
      'bo': 'Bò',
      'thit bo': 'Bò',
      'bò': 'Bò',
      'tiet': 'Tiết',
      'tiết': 'Tiết',
      'tiet bo': 'Tiết',
      // Bê -> Bê ba chỉ
      'be': 'Bê ba chỉ',
      'bê': 'Bê ba chỉ',
      'bè': 'Bê ba chỉ',
      'bé': 'Bê ba chỉ',
      'bc': 'Bê ba chỉ',
      'b.': 'Bê ba chỉ',
      'thit be': 'Bê ba chỉ',
      'thịt bê': 'Bê ba chỉ',
      'be ba chi': 'Bê ba chỉ',
      'bê ba chỉ': 'Bê ba chỉ',
      // Quả bằng
      'bang': 'quả bằng',
      'bằng': 'quả bằng',
      'bong': 'quả bằng',
      'bọng': 'quả bằng',
      'qua bang': 'quả bằng',
      'quả bằng': 'quả bằng',
      'thit bang': 'quả bằng',
      'thịt bằng': 'quả bằng',
      // Quả trắng
      'trang': 'quả trắng',
      'trắng': 'quả trắng',
      'trang bo': 'quả trắng',
      'trắng bò': 'quả trắng',
      'trangbo': 'quả trắng',
      'trang bo': 'quả trắng',
      'tráng bò': 'quả trắng',
      'qua trang': 'quả trắng',
      'quả trắng': 'quả trắng',
      'thit trang': 'quả trắng',
      'thịt trắng': 'quả trắng',
      // Quạt
      'quat': 'quạt',
      'quạt': 'quạt',
      'thit quat': 'quạt',
      'thịt quạt': 'quạt',
      'xuong quat': 'quạt',
      'xương quạt': 'quạt',
      // Thăn
      'than': 'Thăn',
      'thăn': 'Thăn',
      'than bo': 'Thăn',
      'thăn bò': 'Thăn',
      'thit than': 'Thăn',
      'thịt thăn': 'Thăn',
      // Tái
      'tai': 'Tái',
      'tái': 'Tái',
      'thit tai': 'Tái',
      'thịt tái': 'Tái',
      'bo tai': 'Tái',
      'bò tái': 'Tái',
      // Lá, la -> thịt la vai
      'la': 'thịt la vai',
      'lá': 'thịt la vai',
      'thit la': 'thịt la vai',
      'thịt lá': 'thịt la vai',
      'la vai': 'thịt la vai',
      'lá vai': 'thịt la vai',
      'thit la vai': 'thịt la vai',
      'thịt la vai': 'thịt la vai',
      'thit la vay': 'thịt la vai',
      'thịt la vây': 'thịt la vai',
      'thịt lá vai': 'thịt la vai',
      'la bo': 'thịt la vai',
      'lá bò': 'thịt la vai',
      'la xach': 'thịt la vai',
      'lá xách': 'thịt la vai',
      'sach': 'thịt la vai',
      'sách': 'thịt la vai',
      // Sườn
      'suon': 'Sườn',
      'sườn': 'Sườn',
      'suon bo': 'Sườn',
      'sườn bò': 'Sườn',
      'suon vai': 'Sườn bò',
      'sườn vai': 'Sườn bò',
      'suon vay': 'Sườn bò',
      'sườn vay': 'Sườn bò',
      // Vai xay (Bò xay)
      'bo xay': 'Vai xay',
      'bò xay': 'Vai xay',
      'thit bo xay': 'Vai xay',
      'thịt bò xay': 'Vai xay',
      'vai xay': 'Vai xay',
      'thit vai xay': 'Vai xay',
      'thịt vai xay': 'Vai xay',
      'xay': 'Vai xay',
    };

    const baseItemTime = Date.now();
    const itemsToCreate = rawItems.map((item, index) => {
      const rawOriginal = (item.name || '').trim();
      const rawLower = rawOriginal.toLowerCase();
      // Loại bỏ các cụm từ hành động/tên khách/trả hàng nếu vô tình lẫn vào tên món (ví dụ: "chín chị tuyết lấy thêm", "chín gửi về", "trả hàng chín", "gửi lại", "hàng trả", "quay đầu")
      const cleanedRaw = rawLower
        .replace(/\b(lay them|lấy thêm|lay|lấy|them|thêm|cho chi tuyet|cho chị tuyết|chi tuyet|chị tuyết|cua chi tuyet|của chị tuyết|gui ve|gửi về|tra hang|trả hàng|tra ve|trả về|tra lai|trả lại|gui lai|gửi lại|hang tra|hàng trả|thu hoi|thu hồi|quay dau|quay đầu|doi tra|đổi trả|hoan hang|hoàn hàng|tra|trả)\b/gi, '')
        .trim();
      const cleanLower = removeDiacritics(cleanedRaw || rawLower);

      // Ưu tiên chuẩn hóa theo quy tắc từ lóng
      const normalizedName =
        SPECIAL_MEAT_MAP[cleanedRaw] ||
        SPECIAL_MEAT_MAP[rawLower] ||
        SPECIAL_MEAT_MAP[cleanLower] ||
        SPECIAL_MEAT_MAP[removeDiacritics(rawLower)] ||
        (cleanedRaw ? (cleanedRaw.charAt(0).toUpperCase() + cleanedRaw.slice(1)) : rawOriginal || 'Thịt lẻ').trim();
      const cleanItemName = removeDiacritics(normalizedName.toLowerCase());

      // So khớp với danh mục sản phẩm của chủ buôn
      let matchedProd = products.find((p) => {
        const pName = removeDiacritics(p.name.toLowerCase().trim());
        return pName === cleanItemName || cleanItemName.includes(pName) || pName.includes(cleanItemName);
      });

      // Xử lý khối lượng và tiền cho từng dòng:
      // normalizeWeightQuantity chỉ áp dụng cho VIDEO khi người nói đọc các chữ số cân điện tử liền nhau
      let qty = isVideo
        ? normalizeWeightQuantity(item.quantity)
        : (item.quantity != null ? parseFloat(String(item.quantity).replace(',', '.')) : null);
      if (qty != null && (isNaN(qty) || qty <= 0)) {
        qty = null;
      }
      let price = item.price != null ? parseFloat(item.price) : null;
      let amount = item.amount != null ? parseFloat(item.amount) : null;

      // XỬ LÝ RIÊNG CHO HÓA ĐƠN ẢNH (ĐƠN NỢ NHANH):
      // Nếu số ở ô số lượng là số nguyên hàng trăm (>= 100, ví dụ 959, 836, 341) không có dấu phẩy:
      // ĐÂY LÀ TIỀN (NGHÌN ĐỒNG), KHÔNG PHẢI SỐ CÂN!
      if (!isVideo) {
        if (qty != null && !isNaN(qty) && qty >= 100 && (amount == null || amount === 0)) {
          amount = qty < 10000 ? Math.round(qty * 1000) : Math.round(qty);
          if (price == null || price < 1000) {
            price = amount;
          }
          qty = null; // Đơn nợ nhanh, chỉ quét số tiền, không có số cân
        } else if (amount != null && amount > 0 && amount < 10000) {
          amount = Math.round(amount * 1000);
          if (price != null && price < 10000) {
            price = Math.round(price * 1000);
          }
        }
      }

      // Ưu tiên giá riêng của khách hàng cao nhất (bảo toàn theo nguyên tắc Custom Price Integrity)
      const customPriceVal = matchedProd ? customerPriceMap.get(matchedProd.id) : null;
      const isQuickDebtItem = !normalizedName || normalizedName === 'Tiền hàng' || normalizedName === 'Thịt lẻ';

      if (customPriceVal != null && (!isQuickDebtItem || (qty != null && qty > 0))) {
        // Khách hàng có giá riêng cho món này: Bắt buộc áp giá riêng và tính lại thành tiền
        price = customPriceVal;
        if (qty != null && qty > 0) {
          amount = Math.round(price * qty);
        }
      } else if (amount != null && amount > 0) {
        // Đơn nợ nhanh tiền hàng hoặc hóa đơn đã có số tiền chốt
        if (price == null) {
          price = (qty != null && qty > 0) ? Math.round(amount / qty) : amount;
        }
      } else if (price == null && amount != null && qty != null && qty > 0) {
        price = Math.round(amount / qty);
      } else if (amount == null && price != null && qty != null && qty > 0) {
        amount = Math.round(price * qty);
      } else if (price == null && matchedProd && matchedProd.defaultPrice) {
        price = parseFloat(matchedProd.defaultPrice);
        if (amount == null && qty != null && qty > 0) {
          amount = Math.round(price * qty);
        }
      }

      return {
        submissionId,
        rawName: normalizedName,
        matchedProductId: matchedProd ? matchedProd.id : null,
        quantity: qty,
        price: price,
        amount: amount,
        // Gán thời gian tuần tự tăng dần để bảo toàn đúng thứ tự các dòng món thịt từ trên xuống dưới trên hóa đơn gốc
        createdAt: new Date(baseItemTime + index * 50),
        updatedAt: new Date(baseItemTime + index * 50),
      };
    });

    if (itemsToCreate.length === 0) {
      itemsToCreate.push({
        submissionId,
        rawName: '',
        matchedProductId: null,
        quantity: null,
        price: null,
        amount: null,
        createdAt: new Date(baseItemTime),
        updatedAt: new Date(baseItemTime),
      });
    }

    await prisma.staffSubmissionItem.createMany({
      data: itemsToCreate,
    });

    // 9. Cập nhật trạng thái hoàn thành phân tích
    const updated = await prisma.staffSubmission.update({
      where: { id: submissionId },
      data: {
        status: 'READY_FOR_REVIEW',
        date: submissionDate,
        detectedCustomerName: cleanDetectedCustomerName || detectedCustomerName,
        matchedCustomerId,
        note: submissionNote,
        rawAiResponse: JSON.stringify(parsedJson),
        aiError: aiErrorMsg,
      },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
        matchedCustomer: { select: { id: true, name: true, phone: true } },
      },
    });

    // Bắn realtime thông báo cho chủ buôn
    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_READY', updated);

    return updated;
  } catch (error) {
    console.error(`[AI_PARSER ERROR] Lỗi phân tích submissionId ${submissionId}:`, error);

    // Đảm bảo luôn có ít nhất 1 dòng trường nhập liệu cho chủ buôn
    try {
      const existingItemsCount = await prisma.staffSubmissionItem.count({ where: { submissionId } });
      if (existingItemsCount === 0) {
        await prisma.staffSubmissionItem.create({
          data: {
            submissionId,
            rawName: '',
            matchedProductId: null,
            quantity: null,
            price: null,
            amount: null,
          },
        });
      }
    } catch (e) { }

    // Dù lỗi AI, vẫn chuyển sang READY_FOR_REVIEW để chủ buôn tự xem ảnh và nhập tay
    await prisma.staffSubmission.update({
      where: { id: submissionId },
      data: {
        status: 'READY_FOR_REVIEW',
        aiError: error.message || 'Lỗi không xác định khi gọi AI',
      },
    });

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_FAILED', {
      id: submissionId,
      error: error.message,
    });
  }
};

module.exports = {
  parseStaffSubmission,
};
