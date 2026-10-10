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

/**
 * So khớp sản phẩm với danh mục sản phẩm của chủ buôn theo từ khóa chuẩn xác,
 * ngăn chặn triệt để tình trạng nhận nhầm chéo (ví dụ: Diềm bò thành Thăn bò, Lá vai thành Lạc vai).
 */
const matchProductByName = (cleanItemName, products, customerPriceMap = new Map()) => {
  if (!cleanItemName || !Array.isArray(products) || products.length === 0) return null;
  const cleanLower = removeDiacritics(cleanItemName.toLowerCase().trim());
  const cleanNoSpace = cleanLower.replace(/\s+/g, '');

  // 1. So khớp 100% chính xác tuyệt đối (exact match)
  const exactMatches = products.filter((p) => {
    const pClean = removeDiacritics(p.name.toLowerCase().trim());
    return pClean === cleanLower || pClean.replace(/\s+/g, '') === cleanNoSpace;
  });
  if (exactMatches.length > 0) {
    if (customerPriceMap && customerPriceMap.size > 0) {
      const customMatch = exactMatches.find((p) => customerPriceMap.has(p.id));
      if (customMatch) return customMatch;
    }
    return exactMatches[0];
  }

  // 2. Bảo vệ đặc thù: Từ khóa "diềm" (diem) - BẮT BUỘC chỉ khớp Diềm bò / Diềm bò thái, CẤM nhảy sang Thăn bò!
  if (cleanLower.includes('diem')) {
    const isThai = cleanLower.includes('thai');
    const diemProds = products.filter((p) => removeDiacritics(p.name.toLowerCase()).includes('diem'));
    if (diemProds.length > 0) {
      if (customerPriceMap && customerPriceMap.size > 0) {
        const customDiem = diemProds.find((p) => customerPriceMap.has(p.id) && (isThai ? removeDiacritics(p.name.toLowerCase()).includes('thai') : !removeDiacritics(p.name.toLowerCase()).includes('thai')));
        if (customDiem) return customDiem;
      }
      if (isThai) {
        return diemProds.find((p) => removeDiacritics(p.name.toLowerCase()).includes('thai')) || diemProds[0];
      }
      return diemProds.find((p) => !removeDiacritics(p.name.toLowerCase()).includes('thai')) || diemProds[0];
    }
  }

  // 3. Bảo vệ đặc thù: Từ khóa "lá" (la / la vai / lá vai) - BẮT BUỘC khớp Lá vai, CẤM nhảy sang Lạc vai!
  if (cleanLower === 'la' || cleanLower === 'la vai' || cleanLower === 'thit la vai' || cleanLower === 'thit la' || (cleanLower.includes('la vai') && !cleanLower.includes('lac'))) {
    const laVaiProd = products.find((p) => {
      const pClean = removeDiacritics(p.name.toLowerCase().trim());
      return pClean === 'la vai' || (pClean.includes('la vai') && !pClean.includes('lac'));
    });
    if (laVaiProd) return laVaiProd;
  }

  // 4. Từ khóa "lạc vai" / "vai" / "vai bò" - BẮT BUỘC khớp Lạc vai
  if (cleanLower === 'vai' || cleanLower === 'lac vai' || cleanLower === 'thit vai' || cleanLower === 'thit lac vai' || cleanLower === 'vai bo') {
    const lacVaiProd = products.find((p) => {
      const pClean = removeDiacritics(p.name.toLowerCase().trim());
      return pClean === 'lac vai' || pClean.includes('lac vai');
    }) || products.find((p) => {
      const pClean = removeDiacritics(p.name.toLowerCase().trim());
      return pClean.includes('vai') && !pClean.includes('xay') && !pClean.includes('suon') && !pClean.includes('la') && !pClean.includes('u');
    });
    if (lacVaiProd) return lacVaiProd;
  }

  // 5. Từ khóa "xay" / "bò xay" / "vai xay" - BẮT BUỘC khớp bò xay
  if (cleanLower.includes('xay')) {
    const xayProd = products.find((p) => removeDiacritics(p.name.toLowerCase()).includes('xay'));
    if (xayProd) return xayProd;
  }

  // 6. Từ khóa "chín" / "thịt chín" - BẮT BUỘC ưu tiên Chín(vai + lạm) hoặc Chín
  if (cleanLower.includes('chin')) {
    if (customerPriceMap && customerPriceMap.size > 0) {
      const customChin = products.find((p) => customerPriceMap.has(p.id) && removeDiacritics(p.name.toLowerCase()).includes('chin'));
      if (customChin) return customChin;
    }
    const chinProd = products.find((p) => removeDiacritics(p.name.toLowerCase()).includes('chin'));
    if (chinProd) return chinProd;
  }

  // 7. Từ khóa "Xg Bò" / "x" / "xg" / "xương bò" vs "sườn xg"
  if (cleanLower === 'x' || cleanLower === 'xg' || cleanLower === 'xg bo' || cleanLower === 'xuong' || cleanLower === 'xuong bo') {
    const xgBoProd = products.find((p) => {
      const pClean = removeDiacritics(p.name.toLowerCase());
      return (pClean.includes('xg bo') || pClean === 'xg' || pClean === 'xuong bo' || pClean === 'xuong') && !pClean.includes('suon');
    });
    if (xgBoProd) return xgBoProd;
  }
  if (cleanLower.includes('xg') || cleanLower.includes('xuong')) {
    const xgProd = products.find((p) => {
      const pClean = removeDiacritics(p.name.toLowerCase());
      return pClean.includes('suon xg') || (pClean.includes('suon') && (pClean.includes('xg') || pClean.includes('xuong')));
    }) || products.find((p) => removeDiacritics(p.name.toLowerCase()).includes('xg bo'));
    if (xgProd) return xgProd;
  }
  if (cleanLower === 'suon' || cleanLower === 'thit suon') {
    const suonProd = products.find((p) => removeDiacritics(p.name.toLowerCase().trim()) === 'suon');
    if (suonProd) return suonProd;
  }
  if (cleanLower.includes('suon bo')) {
    const suonBoProd = products.find((p) => removeDiacritics(p.name.toLowerCase().trim()) === 'suon bo');
    if (suonBoProd) return suonBoProd;
  }

  // 8. Từ khóa "bắp giây" vs "bắp bò"
  if (cleanLower.includes('giay') || cleanLower.includes('day')) {
    const bapGiayProd = products.find((p) => removeDiacritics(p.name.toLowerCase()).includes('bap giay'));
    if (bapGiayProd) return bapGiayProd;
  }
  if (cleanLower === 'bap' || cleanLower === 'bap bo' || cleanLower === 'thit bap') {
    const bapBoProd = products.find((p) => removeDiacritics(p.name.toLowerCase().trim()) === 'bap bo');
    if (bapBoProd) return bapBoProd;
  }

  // 9. Từ khóa "gầu cộc" vs "gầu bò"
  if (cleanLower.includes('coc')) {
    const gauCocProd = products.find((p) => removeDiacritics(p.name.toLowerCase()).includes('gau coc'));
    if (gauCocProd) return gauCocProd;
  }
  if (cleanLower === 'gau' || cleanLower === 'gau bo' || cleanLower === 'thit gau') {
    const gauBoProd = products.find((p) => removeDiacritics(p.name.toLowerCase().trim()) === 'gau bo');
    if (gauBoProd) return gauBoProd;
  }

  // 10. Từ khóa "lạm gầu" vs "lạm"
  if (cleanLower.includes('lam gau') || cleanLower.includes('nam gau')) {
    const lamGauProd = products.find((p) => removeDiacritics(p.name.toLowerCase()).includes('lam gau'));
    if (lamGauProd) return lamGauProd;
  }
  if (cleanLower === 'lam' || cleanLower === 'thit lam' || cleanLower === 'nam') {
    const lamProd = products.find((p) => {
      const pClean = removeDiacritics(p.name.toLowerCase().trim());
      return pClean === 'lam' || pClean === 'nam';
    });
    if (lamProd) return lamProd;
  }

  // 11. Từ khóa "thăn bò" vs "thăn"
  if (cleanLower === 'than' || cleanLower === 'than bo' || cleanLower === 'thit than') {
    const thanBoProd = products.find((p) => removeDiacritics(p.name.toLowerCase().trim()) === 'than bo') ||
      products.find((p) => removeDiacritics(p.name.toLowerCase().trim()) === 'than');
    if (thanBoProd) return thanBoProd;
  }

  // 12. Từ khóa "tái (bò)" vs "tái"
  if (cleanLower === 'tai' || cleanLower === 'tai bo' || cleanLower === 'tai (bo)' || cleanLower === 'thit tai') {
    const taiProd = products.find((p) => {
      const pClean = removeDiacritics(p.name.toLowerCase().trim());
      return pClean === 'tai (bo)' || pClean === 'tai bo' || pClean === 'tai';
    });
    if (taiProd) return taiProd;
  }

  // 13. Ưu tiên trong bảng giá riêng nếu có so khớp một phần
  if (customerPriceMap && customerPriceMap.size > 0) {
    const customProd = products.find((p) => {
      if (!customerPriceMap.has(p.id)) return false;
      const pClean = removeDiacritics(p.name.toLowerCase().trim());
      return pClean.includes(cleanLower) || cleanLower.includes(pClean);
    });
    if (customProd) return customProd;
  }

  // 14. Fallback chung cuối cùng: So khớp bao hàm chuỗi
  return products.find((p) => {
    const pClean = removeDiacritics(p.name.toLowerCase().trim());
    return pClean.includes(cleanLower) || cleanLower.includes(pClean);
  }) || null;
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

    // 2. Lấy danh sách khách hàng, sản phẩm và nhà cung cấp hiện tại của chủ buôn để làm từ điển đối chiếu cho AI
    const [customers, products, suppliers] = await Promise.all([
      prisma.customer.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, phone: true },
      }),
      prisma.product.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, defaultPrice: true, unit: true },
      }),
      prisma.supplier.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, phone: true },
      }),
    ]);

    const customerNamesList = customers.map((c) => c.name).join(', ');
    const productNamesList = products.map((p) => p.name).join(', ');
    const supplierNamesList = suppliers.map((s) => s.name).join(', ');

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

    // 4. Chuẩn bị System Instruction và User Prompt theo chuẩn Google Gemini
    let systemInstruction = '';
    const userPrompt = isVideo
      ? 'Hãy phân tích video bán thịt đính kèm (kết hợp âm thanh giọng nói và quan sát mặt cân điện tử) theo đúng các quy tắc hệ thống đã định nghĩa.'
      : 'Hãy đọc và trích xuất dữ liệu từ hình ảnh hóa đơn / tích kê bán thịt đính kèm theo đúng các quy tắc hệ thống đã định nghĩa.';

    if (isVideo) {
      systemInstruction = `Bạn là trợ lý AI chuyên gia phân tích VIDEO BÁN/GIAO THỊT BÒ (kết hợp âm thanh giọng nói và hình ảnh mặt cân điện tử / miếng thịt).

DANH BẠ THAM CHIẾU CỬA HÀNG:
- Khách hàng quen: [${customerNamesList || 'Chưa có'}]
- Nhà cung cấp: [${supplierNamesList || 'Chưa có'}]
- Món thịt thường bán: [${productNamesList || 'Chưa có'}]

I. XÁC ĐỊNH TÊN KHÁCH HÀNG (customer_name) TỪ GIỌNG NÓI:
1. Quy tắc nhận diện theo tên gọi:
- "Hương" / "Hương Mỹ Đình" => "Hương mỹ đình(xô 230)".
- "Trường Hoàng" / "Nguyễn Khuyến Trường Hoàng" => "Trường hoàng(nguyễn khuyến)".
- "Thầy" / "Cô Thảo" / "Cô Hảo" / "Cô Thảo thầy" => "Cô thảo(thầy)".
- "Chị Tuyết" / "Tuyết" => "Chị Tuyết".
- "Văn Khê" / "Van Khê" / "Van Hle" => "văn khê" (nếu nói "Bún huế văn khê" hoặc có "Bún Huế" => "Bún huế van khe").
- "3Mien" / "3 Miền" / "Kim Liên" => "Bếp 3 miền kim liên".
- "B1", "bếp 1" => "Bếp hàng xóm 1"; "B2" => "Bếp hàng xóm 2"; "B3" => "Bếp hàng xóm 3"; "B4" / "Vườn xanh" => "Nhà hàng vườn xanh".
- "Hà Trì" => "Hà Trì" (phân biệt rõ: KHÔNG nhầm sang "Chị hạnh sân bóng hà trì" và KHÔNG nhầm sang "Cồ hải").
- "Cồ Hải" / "Cổ Hải" => "Cồ hải".
- "Hạnh" / "Chị Hạnh" / "Hạnh sân bóng" => "Chị hạnh sân bóng hà trì".
- "Huyền" / "Huyền Đô Nghĩa" => "Huyền Đô Nghĩa".
- "Phở Tưởng" / "Chị Luyến" => "Phở tưởng(chị Luyến)" (KHÔNG đọc thành "Phở Tiến").
- "Chinga" / "Chị Thúy Nga" / "Cô Nga" => "Chị Thúy Nga".
- "Anh Nghĩa" / "Thăn Bình Đà" => "Thăn bình đà(anh Nghĩa)".
- "52" / "52 Trần Thái Tông" => "52  trần thái tông".
- "Minh" / "Minh Trang" => "Minh trang".
- "Trung Kính" / "Bếp Trung Kính" => "Trung kính".
- "Thái Hà" => "Thái hà".
- "Anh Thắng phố cổ" => "Anh thắng phố cổ".
- "Phở Đông" => "Phở đông".
- "Gia Hưng CS2" => "Gia Hưng cs2".
- "Giảng Võ" / "Giang Võ" => "Giảng võ".
- "794" / "794 Láng Hạ" / "The Industree" => "794 láng hạ".
- "Cuốn An Khánh" / "An Khang" => "Cuốn an khánh".
- Nếu không nhắc tên khách: trả về customer_name = null.

II. BÓC TÁCH MÓN THỊT (items):
1. Nguyên tắc sống còn: Luôn phải có tên món thịt (name). Tuyệt đối không để trống hoặc trả về rỗng nếu có thịt trên cân.
2. Nhận diện kết hợp:
- Lắng nghe từ ngữ chỉ món thịt.
- Quan sát thị giác miếng thịt trên cân: Thịt luộc chín/nâu sẫm => "Thịt chín"; Nạc đỏ tươi => "Thăn" hoặc "Tái"; Có mỡ trắng/vàng viền quanh => "Gầu Bò" hoặc "Thịt lạm"; Bắp tròn vân hoa => "Bắp Bò"; Tảng có xương => "Sườn"; Xay nhuyễn => "bò xay"; Da mỏng => "Bê ba chỉ".
- Trường hợp không nghe rõ hoặc camera chỉ chĩa mặt cân:
  + Khách Hương: auto món "xô" (đơn giá mặc định 230000).
  + Khách Chị Tuyết: Lấy > 10kg, hoặc trả hàng, hoặc không đọc tên thịt => auto món "Thịt chín". Chỉ điền món khác khi nói rõ tên món và <= 10kg.
  + Khách Cồ Hải: auto món "Thịt lạm" (hoặc "Lạm gầu").
  + Khách Phở Tưởng: auto món "Gầu Bò" (hoặc "Thịt lạm").
  + Khách Thăn Bình Đà: auto món "Thăn".
  + Khách khác: Chọn món phù hợp nhất trong danh mục món thịt thường bán.
3. Chuẩn hóa tên món thịt:
- "vai" / "lạc vai" => "Lạc vai".
- "chín" / "thịt chín" => "Thịt chín" (từ "chín" là tên món thịt chín, KHÔNG phải số 9).
- "lạm" => "Thịt lạm"; "lạm gầu" => "Lạm gầu".
- "gầu" / "gàu" / "gâu" => "Gầu Bò".
- "bê" / "thịt bê" => "Bê ba chỉ".
- "diềm" / "diềm thăn" => "Diềm bò" ("diềm thái" => "Diềm bò thái"). TUYỆT ĐỐI CẤM trả về "Thăn bò".
- "lá" / "la" / "lá vai" => "Lá vai".
- "bò xay" / "vai xay" / "xay" => "bò xay".
- "thăn" / "thịt thăn" => "Thăn bò".
- "tái" / "thịt tái" => "Tái (bò)".
- "bắp giây" / "bắp dây" => "Bắp giây"; "bắp" / "thịt bắp" => "Bắp bò".
- "xg" / "xương" / "x" => "Xg Bò". Xương bò luôn chẵn 5, 10, 15 kg (1 hoặc 1.0 => 10kg; 1.5 => 15kg; 5 => 5kg).

III. ĐỌC SỐ CÂN (quantity) VÀ MẶT CÂN ĐIỆN TỬ:
- 3 chữ số liên tiếp X Y Z => hiểu là X.YZ kg (ví dụ: "tái 1 9 5" => món "Tái", quantity: 1.95; "4 8 4" => 4.84; "3 7 0" => 3.7).
- 4 chữ số liên tiếp AB CD => hiểu là AB.CD kg (ví dụ: "1 6 9 2" => 16.92; "2 0 1 5" => 20.15; "1 2 5 0" => 12.5).
- Khẩu ngữ "lẻ": "6 lẻ 69" => 6.69; "4 lẻ 5" => 4.5; "3 lẻ 05" => 3.05.
- Nếu không đọc số cân: Đọc trực tiếp màn hình LED đỏ trên cân điện tử (ô Khối lượng kg, Đơn giá đ/kg, Thành tiền đ).

IV. ĐƠN TRẢ HÀNG & NHẬP HÀNG:
- Trả hàng ("gửi lại", "gửi về", "trả hàng", "trả về", "hàng trả", "quay đầu"): Đặt "is_return": true, "note": "[Trả lại hàng]". (Khách Chị Tuyết trả hàng không đọc tên thịt => auto "Thịt chín").
- Nhập hàng:
  + Nếu là Khách hàng quen đọc "nhập hàng/nhập thịt": bản chất là khách trả hàng => "is_return": true, "is_import": false, "note": "NHẬP HÀNG".
  + Nếu là Nhà cung cấp / Lò mổ: "is_import": true, "is_return": false, "note": "Nhập hàng", gán customer_name là tên nhà cung cấp.`;
    } else {
      systemInstruction = `Bạn là trợ lý AI chuyên gia hàng đầu về đọc và phân tích hóa đơn, tích kê bán buôn thịt bò viết tay (Trường Nga).

DANH BẠ THAM CHIẾU CỬA HÀNG:
- Khách hàng quen: [${customerNamesList || 'Chưa có'}]
- Nhà cung cấp: [${supplierNamesList || 'Chưa có'}]
- Món thịt thường bán: [${productNamesList || 'Chưa có'}]

0. KIỂM TRA BỐ CỤC HÓA ĐƠN BÁN HÀNG:
- Chỉ bóc tách khi ảnh có bố cục hóa đơn bán hàng tiêu chuẩn: Có tiêu đề in "HÓA ĐƠN BÁN HÀNG", bảng biểu kẻ ô chia cột (STT, Tên hàng, Số lượng, Đơn giá, Thành tiền) hoặc dòng in "Tên khách hàng:".
- Nếu là giấy nháp trắng, mặt sau/mặt lưng hóa đơn, số tính nhẩm linh tinh => Đặt "is_valid_invoice": false, "customer_name": null, "items": [], "note": "Ảnh không có bố cục hóa đơn bán hàng (giấy nháp/mặt sau)".

1. BÓC TÁCH MÓN THỊT & SỐ LIỆU:
- Thứ tự dòng: Bắt buộc bóc tách từ trên xuống dưới (Top-to-Bottom), tuyệt đối không đảo lộn dòng (dòng 1 là items[0], dòng 2 là items[1]...).
- Tự động xoay ảnh nếu ảnh chụp nghiêng hoặc ngược chiều.
- Chuẩn hóa tên món thịt viết tay:
  + "bắp" / "Bắp" => "Bắp Bò".
  + "Gầu" / "Gàu" / "Gau" => "Gầu Bò".
  + "Nam" / "Nạm" / "Lạm" => "Thịt lạm" (nếu ghi "lạm gầu" => "Lạm gầu").
  + "bằng" / "quả bằng" => "quả bằng".
  + "Trắng" / "quả trắng" => "quả trắng".
  + "Quạt" => "quạt".
  + "Thăn" / "thăn bò" => "Thăn bò".
  + "diềm" / "diềm thăn" / "diềm bò" / "dt" => "Diềm bò" (nếu có chữ "thái" => "Diềm bò thái"). TUYỆT ĐỐI CẤM trả về "Thăn bò".
  + "xg" / "x" / "xương" => "Xg Bò". Xương bò luôn chẵn 5, 10, 15 kg (viết giống 1 hoặc 1.0 => auto 10kg; 1.5 => auto 15kg; 5 => 5kg).
  + "Tai" / "Tái" => "Tái (bò)".
  + "bắp giây" / "bắp dây" => "Bắp giây".
  + "Lá" / "lá vai" / "thịt la" => "Lá vai".
  + "vai" / "lạc vai" => "Lạc vai" (KHÔNG nhầm sang "Lá vai" hay "bò xay").
  + "Sườn" => "Sườn".
  + "Sườn xg" (kể cả chữ viết xG/KG/kg có gạch chân dễ nhầm đơn vị) => "Sườn xg".
  + "bò xay" / "vai xay" => "bò xay".
  + "bê" / "bê ba chỉ" => "Bê ba chỉ".
  + "chín" / "thịt chín" => "Thịt chín".

2. QUY TẮC ĐƠN NỢ NHANH & SỐ TIỀN:
- Các con số hàng trăm (959, 836, 341...) HOÀN TOÀN KHÔNG CÓ DẤU CHẤM/PHẨY thập phân, phía dưới có đường gạch chân tổng tiền (ví dụ tổng 2136):
  => ĐÂY LÀ TIỀN (VNĐ = số * 1000), KHÔNG PHẢI SỐ CÂN (CẤM biến thành 9.59kg hay 8.36kg).
  => Trả về quantity: null, price và amount = số * 1000 (ví dụ 959 => 959000).
- Hóa đơn chỉ có các con số tiền cộng lại không ghi tên món (ví dụ 756, 1118, 390 => tổng 2264):
  => "is_quick_debt": true, "sub_amounts": [756000, 1118000, 390000], items gồm 1 dòng: name: "Tiền hàng", quantity: null, price: 2264000, amount: 2264000.
- Hóa đơn chỉ có 1 con số tổng duy nhất ở đáy (ví dụ 1146, 3814): Trả về 1 dòng "Thịt lẻ" với quantity: 1, price = amount = tổng * 1000.
- Hóa đơn có số kg thập phân (ví dụ 5.2, 1.95) và đơn giá: amount = Math.round(quantity * price).

3. NHẬN DIỆN TÊN KHÁCH HÀNG & NÉT CHỮ VIẾT TAY:
- "phở Tưởng" (chữ g có đuôi sổ thòng sâu xuống dưới dòng) => "Phở tưởng(chị Luyến)" (TUYỆT ĐỐI CẤM đọc thành "Phở Tiến").
- "Cô Thảo" / "Cô Hảo" / "Thảo" / "Hảo" / "Thầy" (nét chữ viết tay "Cô Thảo" hay bị nhìn nhầm thành "Cô Hảo") => "Cô thảo(thầy)".
- "Van khê" / "Văn Khê" / "Van Hle" / "Van Hie" / "Van khz" / "Van khe" (chữ viết tay "Van khê" hay bị nhìn nhầm thành "Van Hle" / "Van Hie") => "văn khê" (nếu có chữ "Bún Huế" đi kèm mới là "Bún huế văn khê", còn ghi riêng lẻ "Van khê" / "Văn Khê" / "Van Hle" => "văn khê").
- "3Mien" / "3 Miền" / "Kim Liên" => "Bếp 3 miền kim liên".
- Chữ viết tắt "b1" => "Bếp hàng xóm 1"; "b2" => "Bếp hàng xóm 2"; "b3" => "Bếp hàng xóm 3"; "b4" => "Nhà hàng vườn xanh".
- "Huyền" / "Huyền Đô Nghĩa" => "Huyền Đô Nghĩa" (chỉ quan tâm con số tổng cuối cùng ở đáy => dòng "Thịt lẻ", quantity: 1).
- "chinga" / "Chị Nga" / "Thúy Nga" => "Chị Thúy Nga".
- "anh nghĩa" / "bình đà" => "Thăn bình đà(anh Nghĩa)".
- "An Khang" / "Cuốn an khang" => "Cuốn an khánh".
- "ba luu" / "bà lưu" / "ba liu" => "Bà lưu".
- "Nguyễn Khuyến" đi kèm "Trường Hoàng" => "Nguyễn khuyến trường hoàng".
- Chỉ có "Nguyễn Khuyến" đơn độc (KHÔNG có Hoàng/Trường) => "Sành lẩu CS1".
- Số "52" (hoặc "52 trần thái tông") => "52  trần thái tông".
- "minh" / "mih" / "Minh trang" => "Minh trang".
- "Tuy kh" / "Trung kh" / "Trung kính" => "Trung kính".
- "Thái Hà" / "Hkú Hà" / "Thai Ha" => "Thái hà".
- "Hà Trì" => "Hà Trì" (KHÔNG nhầm sang "Chị hạnh sân bóng hà trì" và KHÔNG nhầm sang "Cồ hải").
- "Hạnh" / "chị Hạnh sân bóng" => "Chị hạnh sân bóng hà trì".
- "Cồ Hải" / "Cổ Hải" => "Cồ hải".
- "Giang Võ" / "Giang Đỏ" / "Giảng Võ" => "Giảng võ".
- Có 3 chữ số "794" (794 lang ha / 794 láng hạ) => "794 láng hạ" (TUYỆT ĐỐI CẤM nhận diện thành "Cuốn láng hạ").
- Tiêu đề "LÒ MỔ MINH THUẤN" / "LÒ MỔ MINH THUẦN" => Nhà cung cấp "Minh thuần" (viết tắt B: Bắp bò, sx/sn: Sườn).
- Ngày hóa đơn: Đọc định dạng DD/MM/YYYY. Bỏ qua nét gạch chéo khóa sổ.

4. ĐƠN TRẢ HÀNG & PHIẾU NHẬP LÒ MỔ:
- Trả hàng ("trả", "trả lại", "gửi về", "hàng trả", dấu trừ "-"): "is_return": true, "is_import": false, "note": "[Trả lại hàng]". (Khách Chị Tuyết trả hàng không ghi tên thịt => auto món "Thịt chín").
- Nhập hàng:
  + Khách hàng quen ghi "nhập/nhập thịt": bản chất là khách trả hàng => "is_return": true, "is_import": false, "note": "NHẬP HÀNG".
  + Nhà cung cấp / Lò mổ: "is_import": true, "is_return": false, "note": "Nhập hàng", bóc tách tên nhà cung cấp vào customer_name.`;
    }

    // 5. Gửi sang Gemini Vision theo chuẩn System Instruction & User Prompt tách biệt
    const geminiResult = await callGeminiWithRetry({
      apiKey: process.env.GEMINI_API_KEY,
      systemInstruction,
      contents: [
        {
          parts: [
            { text: userPrompt },
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
            is_import: { type: 'BOOLEAN', nullable: true },
            note: { type: 'STRING', nullable: true },
            // Khai báo để AI được phép trả về cờ đơn nợ nhanh (trước đây bị schema loại bỏ)
            is_quick_debt: { type: 'BOOLEAN', nullable: true },
            sub_amounts: { type: 'ARRAY', nullable: true, items: { type: 'NUMBER' } },
            items: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING' },
                  // Cho phép null: đơn nợ nhanh chỉ có tiền, không có số cân (prompt yêu cầu quantity: null)
                  quantity: { type: 'NUMBER', nullable: true },
                  price: { type: 'NUMBER', nullable: true },
                  amount: { type: 'NUMBER', nullable: true },
                },
                required: ['name'],
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

    // Nhận diện đơn NHẬP HÀNG (chủ buôn nhập thịt / mua thịt từ nhà cung cấp)
    const importRegex = /(?:nhập hàng|nhap hang|nhập thịt|nhap thit|mua hàng|mua hang|mua thịt|mua thit|nhập vào|nhap vao|mua vào|mua vao|nhập về|nhap ve|mua về|mua ve|lấy vào|lay vao|nhập kho|nhap kho|nhập lò|nhap lo|mua lò|mua lo|lấy thịt về|lay thit ve|lấy hàng về|lay hang ve|nhập lô|nhap lo|\bnhập\b|\bnhap\b|\bmua thịt\b|\bmua hàng\b|\bmua vào\b|\bmua về\b|\bmua\b)/i;
    const isImportOrder = isValidInvoice && Boolean(
      parsedJson.is_import === true ||
      (parsedJson.note && importRegex.test(parsedJson.note)) ||
      (submission.note && importRegex.test(submission.note)) ||
      importRegex.test(geminiResult.text || '')
    );

    // Nhận diện đơn trả hàng (khi khách đọc hoặc viết: gửi về, trả hàng, trả về, trả lại, gửi lại, hàng trả, thu hồi, quay đầu, đổi trả, hoàn hàng...)
    const returnRegex = /(trả hàng|gửi về|trả về|trả lại|gửi lại|hàng trả|thu hồi|bắn về|quay đầu|đổi trả|hoàn hàng|tra hang|gui ve|tra ve|tra lai|gui lai|hang tra|quay dau|doi tra|hoan hang)/i;
    const isReturnOrder = !isImportOrder && isValidInvoice && Boolean(
      parsedJson.is_return === true ||
      (parsedJson.note && returnRegex.test(parsedJson.note)) ||
      (submission.note && returnRegex.test(submission.note)) ||
      (detectedCustomerName && returnRegex.test(detectedCustomerName)) ||
      rawItems.some((it) => returnRegex.test(it.name || '')) ||
      returnRegex.test(geminiResult.text || '')
    );

    // Làm sạch tên đối tác nếu dính các từ khóa trả hàng / nhập hàng
    let cleanDetectedCustomerName = detectedCustomerName;
    if (cleanDetectedCustomerName && (isReturnOrder || isImportOrder)) {
      cleanDetectedCustomerName = cleanDetectedCustomerName
        .replace(/\b(nhập thịt|nhập hàng|mua thịt|mua hàng|nhập vào|mua vào|nhập về|mua về|lấy vào|lấy thịt về|lấy hàng về|nhập lô|nhập kho|nhập lò|mua lò|nhap thit|nhap hang|mua thit|mua hang|nhap vao|mua vao|nhap ve|mua ve|lay vao|nhap kho|nhap lo|mua lo|nhập|nhap|mua|trả hàng|gửi về|trả về|trả lại|gửi lại|hàng trả|thu hồi|bắn về|quay đầu|đổi trả|hoàn hàng|tra hang|gui ve|tra ve|tra lai|gui lai|hang tra|quay dau|doi tra|hoan hang|trả|tra)\b/gi, '')
        .replace(/[-–—:()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // So khớp đối tác trước: Xác định Nhà cung cấp vs Khách hàng
    let matchedCustomerId = null;
    let matchedSupplier = null;
    const customerNameToMatch = cleanDetectedCustomerName || detectedCustomerName;

    // Nếu ban đầu nghi ngờ là đơn nhập hàng: Kiểm tra xem có phải thực sự là NCC không
    if (isImportOrder && customerNameToMatch) {
      const cleanDetected = removeDiacritics(customerNameToMatch.toLowerCase().trim());
      const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

      if (suppliers && suppliers.length > 0) {
        matchedSupplier = suppliers.find((s) => {
          const sClean = removeDiacritics(s.name.toLowerCase().trim());
          const sNoSpace = sClean.replace(/\s+/g, '');
          return sClean === cleanDetected || sNoSpace === cleanDetectedNoSpace || sClean.includes(cleanDetected) || cleanDetected.includes(sClean);
        });
      }

      // Nếu không khớp bất kỳ Nhà cung cấp nào:
      // Bản chất đơn "nhập hàng" của khách hàng là TRẢ HÀNG (trừ nợ), chỉ thay text ghi chú là "NHẬP HÀNG"!
      if (!matchedSupplier) {
        isImportOrder = false;
        isReturnOrder = true;
      }
    }

    if (isImportOrder) {
      parsedJson.is_import = true;
      parsedJson.is_return = false;
      parsedJson.target_type = 'supplier';
    } else if (isReturnOrder) {
      parsedJson.is_return = true;
      parsedJson.is_import = false;
      parsedJson.target_type = 'customer';
    } else {
      parsedJson.is_return = false;
      parsedJson.is_import = false;
      parsedJson.target_type = 'customer';
    }

    // Chuẩn bị note của submission:
    // - Đơn nhập hàng của khách hàng: Ghi chú "NHẬP HÀNG", loại đơn TRẢ HÀNG
    // - Đơn trả hàng: Ghi chú "Trả hàng"
    // - Đơn nhập nhà cung cấp: Ghi chú "Nhập hàng"
    // - Đơn nợ mới: để trống
    let submissionNote = '';
    if (!isValidInvoice) {
      submissionNote = '[Không phải hóa đơn] Giấy nháp / Mặt sau';
    } else if (isImportOrder) {
      submissionNote = 'Nhập hàng';
      parsedJson.note = 'Nhập hàng';
    } else if (isReturnOrder) {
      const hasImportWord = (
        (parsedJson.note && importRegex.test(parsedJson.note)) ||
        (submission.note && importRegex.test(submission.note)) ||
        importRegex.test(geminiResult.text || '')
      );
      submissionNote = hasImportWord ? 'NHẬP HÀNG' : 'Trả hàng';
      parsedJson.note = submissionNote;
    } else {
      submissionNote = ''; // Đơn nợ mới: không cần nhập gì
    }

    // 6. Giữ nguyên ngày nộp hiện tại của submission
    const submissionDate = submission.date || new Date();

    // 7. Gán kết quả khớp đối tác
    if (isImportOrder) {
      if (matchedSupplier) {
        parsedJson.matched_supplier_id = matchedSupplier.id;
        parsedJson.supplier_name = matchedSupplier.name;
      } else {
        parsedJson.supplier_name = customerNameToMatch;
      }
    } else if (customerNameToMatch) {
      const cleanDetected = removeDiacritics(customerNameToMatch.toLowerCase().trim());
      const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

      // 0a. ĐẶC BIỆT: Khớp ưu tiên khách "Bếp trung kính" nếu AI nhận diện là "Trung kính", "trung kh", "tuy kh", "trungkinh"...
      // BẮT BUỘC ưu tiên tìm khách có chứa "bep trung kinh" / "bep" + "trung" + "kinh" trước,
      // TUYỆT ĐỐI không để Rule 0 (Exact Match) khớp nhầm vào khách "Trungkinh"!
      const isDetectedTrungKinh =
        cleanDetected.includes('trung kinh') ||
        cleanDetected.includes('bep trung kinh') ||
        cleanDetected.includes('tuy kinh') ||
        cleanDetected.includes('tung kinh') ||
        cleanDetected.includes('truy kinh') ||
        cleanDetected.includes('tug kinh') ||
        cleanDetected.includes('trung kh') ||
        cleanDetected.includes('tuy kh') ||
        cleanDetected.includes('tuy ks') ||
        cleanDetected.includes('tug kh') ||
        cleanDetected.includes('tung kh') ||
        cleanDetected.includes('truy kh') ||
        cleanDetectedNoSpace === 'trungkinh' ||
        cleanDetectedNoSpace === 'tuykinh' ||
        cleanDetectedNoSpace === 'tungkinh' ||
        cleanDetectedNoSpace === 'truykinh' ||
        cleanDetectedNoSpace === 'tugkinh' ||
        cleanDetectedNoSpace === 'tuykh' ||
        cleanDetectedNoSpace === 'tuykhs' ||
        cleanDetectedNoSpace === 'tuyks' ||
        cleanDetectedNoSpace === 'tugkh' ||
        cleanDetectedNoSpace === 'tungkh' ||
        cleanDetectedNoSpace === 'truykh' ||
        cleanDetectedNoSpace.includes('trungkinh') ||
        cleanDetectedNoSpace.includes('tuykinh') ||
        cleanDetectedNoSpace.includes('beptrungkinh') ||
        (cleanDetected.includes('trung') && cleanDetected.includes('kinh'));

      if (isDetectedTrungKinh) {
        const bepTrungKinhCust = customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase().trim());
          return cClean.includes('bep trung kinh') || (cClean.includes('bep') && cClean.includes('trung') && cClean.includes('kinh'));
        }) || customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase().trim());
          return cClean.includes('trung kinh') || cClean === 'trungkinh';
        }) || null;

        if (bepTrungKinhCust) {
          matchedCustomerId = bepTrungKinhCust.id;
        }
      }

      if (!matchedCustomerId) {
        // Ưu tiên khớp khách "Cuốn an khánh" nếu AI nhận diện là "An Khang", "an khang", "ankhang", "an khanh", "cuon an khang"...
        if (
          cleanDetectedNoSpace === 'ankhang' ||
          cleanDetectedNoSpace === 'ankhanh' ||
          cleanDetected.includes('an khang') ||
          cleanDetected.includes('an khanh') ||
          cleanDetectedNoSpace.includes('ankhang') ||
          cleanDetectedNoSpace.includes('ankhanh') ||
          cleanDetected.includes('cuon an khang')
        ) {
          const cuonAnKhanhCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('cuon an khanh') || (cClean.includes('an khanh') && cClean.includes('cuon'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('an khanh');
          });
          if (cuonAnKhanhCust) {
            matchedCustomerId = cuonAnKhanhCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // 0. BẮT BUỘC ƯU TIÊN KHỚP CHÍNH XÁC 100% (Exact Match) TRƯỚC TIÊN
        // Nếu tên khách AI bóc tách trùng khớp hoàn toàn với một khách trong DB (ví dụ: "Hồng hạnh hqv")
        // thì chọn ngay khách này, TUYỆT ĐỐI không để các rule heuristic phía dưới ghi đè!
        const exactCust = customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase().trim());
          const cCleanNoSpace = cClean.replace(/\s+/g, '');
          return cClean === cleanDetected || cCleanNoSpace === cleanDetectedNoSpace;
        });
        if (exactCust) {
          matchedCustomerId = exactCust.id;
        }
      }

      // Ưu tiên khớp khách Cô thảo(thầy) nếu AI nhận diện là thầy, cô thảo, hoặc bị đọc nhầm thành cô hảo / hảo
      if (
        cleanDetectedNoSpace === 'thay' ||
        cleanDetectedNoSpace === 'cothao' ||
        cleanDetectedNoSpace === 'thao' ||
        cleanDetectedNoSpace === 'cohao' ||
        cleanDetectedNoSpace === 'hao' ||
        cleanDetected.includes('thay') ||
        cleanDetected.includes('thao') ||
        cleanDetected.includes('co hao') ||
        cleanDetected === 'hao'
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
        // Khớp ưu tiên khách "Bếp 3 Miền Kim Liên" nếu AI nhận diện là 3mien, 3 miền, ba miền, kim liên, bếp 3 miền...
        if (
          cleanDetectedNoSpace === '3mien' ||
          cleanDetectedNoSpace.includes('3mien') ||
          cleanDetectedNoSpace === '3m' ||
          cleanDetected.includes('3 mien') ||
          cleanDetected.includes('ba mien') ||
          cleanDetected.includes('bep 3 mien') ||
          cleanDetected.includes('kim lien') ||
          cleanDetectedNoSpace.includes('kimlien') ||
          cleanDetectedNoSpace.includes('bep3mien') ||
          cleanDetectedNoSpace.includes('bamien')
        ) {
          const bep3MienCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            const cNoSpace = cClean.replace(/\s+/g, '');
            return (cClean.includes('3 mien') || cNoSpace.includes('3mien') || cClean.includes('ba mien')) && cClean.includes('kim lien');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('kim lien');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            const cNoSpace = cClean.replace(/\s+/g, '');
            return (cClean.includes('3 mien') || cNoSpace.includes('3mien') || cClean.includes('ba mien') || cClean.includes('bep 3 mien')) && c.name.toLowerCase() !== '3mien';
          });
          if (bep3MienCust) matchedCustomerId = bep3MienCust.id;
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
            return cClean.includes('bep trung kinh') || (cClean.includes('bep') && cClean.includes('trung') && cClean.includes('kinh'));
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
        // 1) Nếu có chữ "bun hue", "bunhue", "bun bo hue", hoặc có cả "bun" và ("van khe" / "van hle") -> Khách "Bún huế van khe"
        const hasBunHue = cleanDetected.includes('bun hue') || cleanDetected.includes('bun bo hue') ||
          cleanDetectedNoSpace.includes('bunhue') || (cleanDetected.includes('bun') && (cleanDetected.includes('van khe') || cleanDetected.includes('van hle')));

        // 2) Nếu là "van khe", hoặc bị đọc nhầm chữ viết tay thành "van hle", "van hie", "van khz", "hle" (hoàn toàn KHÔNG có chữ "bun" hay "hue") -> Khách "văn khê"
        const isOnlyVanKhe = (
          cleanDetected.includes('van khe') ||
          cleanDetectedNoSpace.includes('vankhe') ||
          cleanDetected.includes('van hle') ||
          cleanDetectedNoSpace.includes('vanhle') ||
          cleanDetected.includes('van hie') ||
          cleanDetectedNoSpace.includes('vanhie') ||
          cleanDetected.includes('van khz') ||
          cleanDetectedNoSpace.includes('vankhz') ||
          cleanDetected.includes('van kh2') ||
          cleanDetectedNoSpace.includes('vankh2') ||
          cleanDetected === 'hle' ||
          cleanDetectedNoSpace === 'hle'
        ) && !hasBunHue && !cleanDetected.includes('bun') && !cleanDetected.includes('hue');

        if (isOnlyVanKhe) {
          const vanKheCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'van khe' || (cClean.includes('van khe') && !cClean.includes('bun') && !cClean.includes('hue'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('khe') && !cClean.includes('bun') && !cClean.includes('hue');
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
        // Khớp ưu tiên khách "Bếp 3 Miền Kim Liên" nếu AI nhận diện là 3mien, 3 miền, ba miền, kim liên, bếp 3 miền...
        if (
          cleanDetectedNoSpace === '3mien' ||
          cleanDetectedNoSpace.includes('3mien') ||
          cleanDetectedNoSpace === '3m' ||
          cleanDetected.includes('3 mien') ||
          cleanDetected.includes('ba mien') ||
          cleanDetected.includes('bep 3 mien') ||
          cleanDetected.includes('kim lien') ||
          cleanDetectedNoSpace.includes('kimlien') ||
          cleanDetectedNoSpace.includes('bep3mien') ||
          cleanDetectedNoSpace.includes('bamien')
        ) {
          const bep3MienCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            const cNoSpace = cClean.replace(/\s+/g, '');
            return (cClean.includes('3 mien') || cNoSpace.includes('3mien') || cClean.includes('ba mien')) && cClean.includes('kim lien');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            const cNoSpace = cClean.replace(/\s+/g, '');
            return cClean.includes('3 mien') || cNoSpace.includes('3mien') || cClean.includes('ba mien') || cClean.includes('bep 3 mien');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('kim lien');
          });
          if (bep3MienCust) matchedCustomerId = bep3MienCust.id;
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
        // LƯU Ý: TUYỆT ĐỐI không để "anh tường mỗ" bị nhầm vào rule này!
        if (
          cleanDetected.includes('pho tuong') ||
          // Chỉ match 'tuong' khi KHÔNG có 'tuong mo' hoặc 'anh tuong' (để phân biệt "Anh tường mỗ")
          (cleanDetected.includes('tuong') && !cleanDetected.includes('tuong mo') && !cleanDetected.includes('anh tuong')) ||
          cleanDetected.includes('luyen') ||
          cleanDetectedNoSpace.includes('photuong') ||
          // Tương tự với no-space: loại trừ 'anhtuong' và 'tuongmo'
          (cleanDetectedNoSpace.includes('tuong') && !cleanDetectedNoSpace.includes('tuongmo') && !cleanDetectedNoSpace.includes('anhtuong')) ||
          cleanDetectedNoSpace.includes('luyen')
        ) {
          // Luôn ưu tiên khách "Phở tưởng(chị Luyến)" trước mọi khách khác
          const phoTuongCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('tuong') || cClean.includes('pho tuong')) && cClean.includes('luyen');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('luyen');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('tuong') && !cClean.includes('tien');
          });
          if (phoTuongCust) {
            matchedCustomerId = phoTuongCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Trường hoàng(nguyễn khuyến)" nếu AI nhận diện là trường hoàng hoặc nguyễn khuyến trường hoàng
        if (
          (cleanDetected.includes('truong') && cleanDetected.includes('hoang')) ||
          cleanDetected.includes('truong hoang') ||
          cleanDetectedNoSpace.includes('truonghoang') ||
          (cleanDetected.includes('khuyen') && cleanDetected.includes('truong'))
        ) {
          const truongHoangCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('truong') && cClean.includes('hoang');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('truong') && cClean.includes('khuyen');
          });
          if (truongHoangCust) {
            matchedCustomerId = truongHoangCust.id;
          }
        }
      }

      if (!matchedCustomerId) {
        // Khớp ưu tiên khách "Chị Thúy Nga" nếu AI nhận diện là chinga, chị nga, nga, thuy nga
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
            return (cClean.includes('thuy') && cClean.includes('nga')) || cClean === 'chinga';
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('chi nga') || cClean === 'nga' || cClean.startsWith('nga ')) && !cClean.includes('tuyet') && !cClean.includes('toan nga');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('nga') && !cClean.includes('tuyet') && !cClean.includes('toan nga');
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
        // Khớp ưu tiên khách "Chị hạnh sân bóng hà trì" nếu AI nhận diện là hạnh, chị hạnh, hanh, chi hanh, hạnh sân bóng...
        // TUYỆT ĐỐI không để khớp nhầm sang khách "Hạnh" (isBadDebt=true)
        const isHanhMatch = (
          cleanDetected === 'hanh' ||
          cleanDetected === 'chi hanh' ||
          cleanDetected === 'co hanh' ||
          cleanDetected === 'ba hanh' ||
          cleanDetected === 'em hanh' ||
          cleanDetected.includes('hanh san bong') ||
          cleanDetected.includes('san bong ha tri') ||
          cleanDetected.includes('hanh ha tri') ||
          cleanDetectedNoSpace === 'hanh' ||
          cleanDetectedNoSpace === 'chihanh' ||
          cleanDetectedNoSpace.includes('hanhsanbong') ||
          cleanDetectedNoSpace.includes('sanbonghatri')
        );

        if (isHanhMatch) {
          const hanhCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('hanh') && (cClean.includes('san bong') || cClean.includes('ha tri')) && c.isActive && !c.isBadDebt;
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('hanh') && (cClean.includes('san bong') || cClean.includes('ha tri'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('hanh') && c.isActive && !c.isBadDebt;
          });
          if (hanhCust) {
            matchedCustomerId = hanhCust.id;
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

    // Xử lý đặc thù cho video khách "Chị Tuyết":
    // 1) Khi lấy thịt số lượng lớn > 10kg thì auto là chín
    // 2) Nếu không đọc tên thịt (hoặc tên thịt chung chung), thì auto là chín
    const isTuyetCustomerEarly = cleanCustDetected.includes('tuyet') ||
      (matchedCustomerId && customers.some((c) => c.id === matchedCustomerId && removeDiacritics(c.name.toLowerCase()).includes('tuyet')));

    if (isVideo && isTuyetCustomerEarly) {
      rawItems.forEach((item) => {
        const itemClean = removeDiacritics((item.name || '').toLowerCase().trim());
        const qtyVal = item.quantity != null ? parseFloat(String(item.quantity).replace(',', '.')) : null;
        const isLargeQty = qtyVal != null && qtyVal > 10;
        const isNoMeatName = !itemClean || ['thit', 'thit bo', 'thit le', 'mon le', 'thit thai', 'than', 'than bo', ''].includes(itemClean) || !item.name;

        // Khách chị Tuyết: số lượng lớn > 10kg HOẶC không đọc tên thịt -> auto là Thịt chín
        if (isLargeQty || isNoMeatName) {
          item.name = 'Thịt chín';
          // Tìm giá riêng món chín của Tuyết (Chín(vai + lạm) - 145k) trong bảng giá riêng
          const chinProd = products.find((p) => {
            const pClean = removeDiacritics(p.name.toLowerCase().trim());
            return customerPriceMap.has(p.id) && (pClean.includes('chin') || pClean === 'chin');
          }) || products.find((p) => {
            const pClean = removeDiacritics(p.name.toLowerCase().trim());
            return pClean.includes('chin') || pClean === 'chin';
          });
          if (chinProd && customerPriceMap.has(chinProd.id)) {
            item.price = customerPriceMap.get(chinProd.id);
            if (qtyVal != null) {
              item.amount = Math.round(qtyVal * item.price);
            }
          }
        }
      });
    }

    // Fallback thông minh cho video: Nếu có số kg nhưng tên thịt bị bỏ trống hoặc chung chung
    if (isVideo) {
      rawItems.forEach((item) => {
        const itemClean = removeDiacritics((item.name || '').toLowerCase().trim());
        if (!itemClean || ['thit', 'thit bo', 'thit le', 'mon le', 'thit thai', ''].includes(itemClean)) {
          if (isTuyetCustomerEarly) {
            item.name = 'Thịt chín';
          } else if (customerPriceMap.size > 0) {
            const firstProdId = customerPriceMap.keys().next().value;
            const customProd = products.find((p) => p.id === firstProdId);
            if (customProd) {
              item.name = customProd.name;
              if (item.price == null) item.price = customerPriceMap.get(firstProdId);
            }
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
      // Thăn bò (DB: "Thăn bò")
      'than': 'Thăn bò',
      'thăn': 'Thăn bò',
      'than bo': 'Thăn bò',
      'thăn bò': 'Thăn bò',
      'thit than': 'Thăn bò',
      'thịt thăn': 'Thăn bò',
      // Tái (bò) (DB: "Tái (bò)")
      'tai': 'Tái (bò)',
      'tái': 'Tái (bò)',
      'thit tai': 'Tái (bò)',
      'thịt tái': 'Tái (bò)',
      'bo tai': 'Tái (bò)',
      'bò tái': 'Tái (bò)',
      // Diềm bò & Diềm bò thái (DB: "Diềm bò", "Diềm bò thái")
      // Người dùng đã đổi từ "Diềm thăn" sang "Diềm bò", bắt buộc map mọi biến thể diềm thăn/diềm về Diềm bò
      'diem': 'Diềm bò',
      'diềm': 'Diềm bò',
      'diem bo': 'Diềm bò',
      'diềm bò': 'Diềm bò',
      'diem than': 'Diềm bò',
      'diềm thăn': 'Diềm bò',
      'diem than bo': 'Diềm bò',
      'diềm thăn bò': 'Diềm bò',
      'thit diem': 'Diềm bò',
      'thịt diềm': 'Diềm bò',
      'dt': 'Diềm bò',
      'd bo': 'Diềm bò',
      'd bò': 'Diềm bò',
      'diem thai': 'Diềm bò thái',
      'diềm thái': 'Diềm bò thái',
      'diem bo thai': 'Diềm bò thái',
      'diềm bò thái': 'Diềm bò thái',
      // Lá vai (DB: "Lá vai")
      'la': 'Lá vai',
      'lá': 'Lá vai',
      'thit la': 'Lá vai',
      'thịt lá': 'Lá vai',
      'la vai': 'Lá vai',
      'lá vai': 'Lá vai',
      'thit la vai': 'Lá vai',
      'thịt la vai': 'Lá vai',
      'thit la vay': 'Lá vai',
      'thịt la vây': 'Lá vai',
      'thịt lá vai': 'Lá vai',
      'la bo': 'Lá vai',
      'lá bò': 'Lá vai',
      'la xach': 'Lá vai',
      'lá xách': 'Lá vai',
      'sach': 'Lá vai',
      'sách': 'Lá vai',
      // Sườn
      'suon': 'Sườn',
      'sườn': 'Sườn',
      'suon bo': 'Sườn',
      'sườn bò': 'Sườn',
      'suon vai': 'Sườn bò',
      'sườn vai': 'Sườn bò',
      'suon vay': 'Sườn bò',
      'sườn vay': 'Sườn bò',
      // Lạc vai (Khi ghi hoặc nói là "vai", "thịt vai", "lạc vai")
      'vai': 'Lạc vai',
      'thit vai': 'Lạc vai',
      'thịt vai': 'Lạc vai',
      'lac vai': 'Lạc vai',
      'lạc vai': 'Lạc vai',
      'thit lac vai': 'Lạc vai',
      'thịt lạc vai': 'Lạc vai',
      'vai bo': 'Lạc vai',
      'vai bò': 'Lạc vai',
      // bò xay (DB: "bò xay")
      'bo xay': 'bò xay',
      'bò xay': 'bò xay',
      'thit bo xay': 'bò xay',
      'thịt bò xay': 'bò xay',
      'vai xay': 'bò xay',
      'thit vai xay': 'bò xay',
      'thịt vai xay': 'bò xay',
      'xay': 'bò xay',
      // Bắp giây (DB: "Bắp giây")
      'bap giay': 'Bắp giây',
      'bắp giây': 'Bắp giây',
      'bap day': 'Bắp giây',
      'bắp dây': 'Bắp giây',
      'giay': 'Bắp giây',
      'giây': 'Bắp giây',
      // Gầu cộc (DB: "Gầu cộc")
      'gau coc': 'Gầu cộc',
      'gầu cộc': 'Gầu cộc',
      'gau coc bo': 'Gầu cộc',
      'gầu cộc bò': 'Gầu cộc',
    };

    const baseItemTime = Date.now();
    // Lấy thông tin khách hàng đã so khớp nếu có
    const matchedCustomer = matchedCustomerId ? customers.find((c) => c.id === matchedCustomerId) : null;
    const itemsToCreate = rawItems.map((item, index) => {
      const rawOriginal = (item.name || '').trim();
      const rawLower = rawOriginal.toLowerCase();
      // Loại bỏ các cụm từ hành động/tên khách/trả hàng nếu vô tình lẫn vào tên món (ví dụ: "chín chị tuyết lấy thêm", "chín gửi về", "trả hàng chín", "gửi lại", "hàng trả", "quay đầu")
      const cleanedRaw = rawLower
        .replace(/\b(lay them|lấy thêm|lay|lấy|them|thêm|cho chi tuyet|cho chị tuyết|chi tuyet|chị tuyết|cua chi tuyet|của chị tuyết|gui ve|gửi về|tra hang|trả hàng|tra ve|trả về|tra lai|trả lại|gui lai|gửi lại|hang tra|hàng trả|thu hoi|thu hồi|quay dau|quay đầu|doi tra|đổi trả|hoan hang|hoàn hàng|tra|trả)\b/gi, '')
        .trim();
      const cleanLower = removeDiacritics(cleanedRaw || rawLower);

      // Ưu tiên chuẩn hóa theo quy tắc từ lóng
      let normalizedName =
        SPECIAL_MEAT_MAP[cleanedRaw] ||
        SPECIAL_MEAT_MAP[rawLower] ||
        SPECIAL_MEAT_MAP[cleanLower] ||
        SPECIAL_MEAT_MAP[removeDiacritics(rawLower)] ||
        (cleanedRaw ? (cleanedRaw.charAt(0).toUpperCase() + cleanedRaw.slice(1)) : rawOriginal || 'Thịt lẻ').trim();

      // Xử lý khối lượng cho từng dòng:
      // normalizeWeightQuantity chỉ áp dụng cho VIDEO khi người nói đọc các chữ số cân điện tử liền nhau
      let qty = isVideo
        ? normalizeWeightQuantity(item.quantity)
        : (item.quantity != null ? parseFloat(String(item.quantity).replace(',', '.')) : null);
      if (qty != null && (isNaN(qty) || qty <= 0)) {
        qty = null;
      }

      // QUY TẮC BẢO VỆ ĐẶC BIỆT CHO XG BÒ (XƯƠNG BÒ):
      // Xg bò không bao giờ là 1 và 1.5 kg, auto là 5, 10, 15 kg
      // Chỉ áp dụng cho đúng món Xg Bò, TUYỆT ĐỐI loại trừ "Sườn xg" (sườn bán lẻ 1 - 1.5kg là bình thường)
      const isSuonXg = cleanLower.includes('suon') || normalizedName === 'Sườn xg';
      const isXgBo = !isSuonXg && Boolean(
        normalizedName === 'Xg Bò' ||
        ['x', 'xg', 'xg bo', 'xuong', 'xuong bo'].includes(cleanLower)
      );
      if (isXgBo && qty != null) {
        if (qty === 1 || qty === 1.0) {
          qty = 10;
        } else if (qty === 1.5) {
          qty = 15;
        }
      }

      // QUY TẮC ĐẶC THÙ CHO KHÁCH CHỊ TUYẾT:
      // 1) Khi lấy thịt số lượng lớn > 10kg thì auto là chín
      // 2) Nếu không đọc tên thịt (hoặc tên thịt chung chung), thì auto là chín
      // 3) Khi gửi lại / trả hàng mà không đọc rõ tên thịt, mặc định là Thịt chín
      const isTuyetCustomer = Boolean(
        (customerNameToMatch && removeDiacritics(customerNameToMatch.toLowerCase()).includes('tuyet')) ||
        (matchedCustomer && removeDiacritics(matchedCustomer.name.toLowerCase()).includes('tuyet')) ||
        (cleanCustDetected && cleanCustDetected.includes('tuyet'))
      );

      const isLargeQtyForTuyet = isTuyetCustomer && qty != null && qty > 10;
      const isNoMeatNameForTuyet = isTuyetCustomer && (
        !cleanedRaw ||
        normalizedName === 'Thịt lẻ' ||
        normalizedName === 'Tiền hàng' ||
        normalizedName === '' ||
        !item.name ||
        ['thit', 'thit bo', 'thit le', 'mon le', 'thit thai', 'than', 'than bo', 'thit than'].includes(cleanLower)
      );

      if (isTuyetCustomer && (isLargeQtyForTuyet || isNoMeatNameForTuyet || isReturnOrder)) {
        normalizedName = 'Thịt chín';
      }

      const cleanItemName = removeDiacritics(normalizedName.toLowerCase());

      // So khớp với danh mục sản phẩm của chủ buôn bằng thuật toán so khớp chính xác matchProductByName
      const matchedProd = matchProductByName(cleanItemName, products, customerPriceMap);

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
  matchProductByName,
};

