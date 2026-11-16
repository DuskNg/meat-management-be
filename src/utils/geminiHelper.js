// meat-management-be/src/utils/geminiHelper.js
// Giới hạn số luồng gọi Gemini đồng thời (tối đa 3) tránh lỗi 429 và quá tải RAM khi nhân viên gửi hàng loạt
const MAX_CONCURRENT_GEMINI = 3;
let activeGeminiCount = 0;
const geminiWaitQueue = [];

const acquireGeminiSlot = () => {
  if (activeGeminiCount < MAX_CONCURRENT_GEMINI) {
    activeGeminiCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    geminiWaitQueue.push(resolve);
  });
};

const releaseGeminiSlot = () => {
  const next = geminiWaitQueue.shift();
  if (next) {
    next();
  } else {
    activeGeminiCount = Math.max(0, activeGeminiCount - 1);
  }
};

/**
 * Tải file lớn (video) lên Gemini File API để tránh nhét Base64 khổng lồ vào JSON body
 */
const uploadBufferToGeminiFileApi = async (buffer, mimeType, apiKey = process.env.GEMINI_API_KEY) => {
  const activeKey = apiKey || process.env.GEMINI_API_KEY;
  if (!activeKey || !buffer || buffer.length === 0) return null;

  try {
    const startCtrl = new AbortController();
    const startTimer = setTimeout(() => startCtrl.abort(), 15000);
    let startRes;
    try {
      startRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${activeKey}`,
        {
          method: 'POST',
          headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(buffer.length),
            'X-Goog-Upload-Header-Content-Type': mimeType,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ file: { display_name: `sub_${Date.now()}` } }),
          signal: startCtrl.signal,
        }
      );
    } finally {
      clearTimeout(startTimer);
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!startRes.ok || !uploadUrl) return null;

    const upCtrl = new AbortController();
    const upTimer = setTimeout(() => upCtrl.abort(), 60000);
    let upRes;
    try {
      upRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Length': String(buffer.length),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: buffer,
        signal: upCtrl.signal,
      });
    } finally {
      clearTimeout(upTimer);
    }

    if (!upRes.ok) return null;
    const upJson = await upRes.json();
    let fileInfo = upJson?.file;
    if (!fileInfo?.uri) return null;

    // Chờ video chuyển sang trạng thái ACTIVE (tối đa 30s)
    const fileName = fileInfo.name;
    let pollAttempts = 0;
    while (fileInfo.state === 'PROCESSING' && pollAttempts < 15) {
      await new Promise((r) => setTimeout(r, 2000));
      pollAttempts++;
      const statusRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${activeKey}`);
      if (statusRes.ok) {
        fileInfo = await statusRes.json();
      } else {
        break;
      }
    }

    if (fileInfo.state === 'FAILED') return null;
    return {
      fileUri: fileInfo.uri,
      mimeType: fileInfo.mimeType || mimeType,
    };
  } catch (err) {
    console.warn('[GEMINI_FILE_API_WARN] Lỗi tải lên File API, chuyển fallback inlineData:', err.message);
    return null;
  }
};

/**
 * Hàm gọi Google Gemini API với cơ chế tự động thử lại (Retry with exponential backoff)
 * và chuyển đổi model dự phòng khi gặp lỗi 503 (Overloaded) hoặc 429 (Rate Limit).
 */
const callGeminiWithRetry = async ({
  contents,
  systemInstruction = null,
  generationConfig = {},
  models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'],
  apiKey = process.env.GEMINI_API_KEY,
  maxRetries = 3,
  timeoutMs = 90000,
}) => {
  const activeKey = apiKey || process.env.GEMINI_API_KEY;
  if (!activeKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY.');
  }

  await acquireGeminiSlot();
  try {
    let lastError = null;

    for (const model of models) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`;

          const payload = {
            contents,
            generationConfig: {
              responseMimeType: 'application/json',
              ...generationConfig,
            },
          };

          if (systemInstruction) {
            payload.systemInstruction = typeof systemInstruction === 'string'
              ? { parts: [{ text: systemInstruction }] }
              : systemInstruction;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          let response;
          try {
            response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          if (response.ok) {
            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) {
              throw new Error('Gemini không phản hồi nội dung.');
            }
            return {
              text,
              usageMetadata: result.usageMetadata || {},
              model,
            };
          }

          const errText = await response.text();
          const statusCode = response.status;
          lastError = new Error(`Lỗi Gemini API: ${statusCode} - ${errText}`);

          // Nếu lỗi 503 (Quá tải) hoặc 429 (Giới hạn tốc độ) và còn lượt retry
          if ((statusCode === 503 || statusCode === 429) && attempt < maxRetries) {
            const delayMs = (attempt + 1) * 2000 + Math.floor(Math.random() * 1000);
            console.warn(`[GEMINI ${model}] Gặp lỗi ${statusCode}, đang thử lại sau ${delayMs}ms (Lần ${attempt + 1}/${maxRetries})...`);
            await new Promise((res) => setTimeout(res, delayMs));
            continue;
          }

          // Nếu là lỗi 404 (Model không tồn tại) hoặc hết lượt retry cho model này, chuyển sang model tiếp theo
          break;
        } catch (err) {
          const isTimeout = err?.name === 'AbortError';
          lastError = isTimeout ? new Error(`Gemini API quá thời gian chờ (${Math.round(timeoutMs / 1000)}s) trên model ${model}.`) : err;
          if (isTimeout) {
            console.warn(`[GEMINI ${model}] Quá thời gian chờ (${timeoutMs}ms), thử lại hoặc chuyển model...`);
          }
          if (attempt < maxRetries) {
            await new Promise((res) => setTimeout(res, 1000));
          }
        }
      }
    }

    throw lastError || new Error('Không thể kết nối đến hệ thống Google Gemini.');
  } finally {
    releaseGeminiSlot();
  }
};

module.exports = {
  callGeminiWithRetry,
  uploadBufferToGeminiFileApi,
};
