// meat-management-be/src/controllers/media.js
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Proxy streaming video / audio với hỗ trợ đầy đủ HTTP Range (206 Partial Content)
 * Giúp trình duyệt xem video mượt mà, không bị nghẽn range request từ Cloudflare R2
 */
const streamMedia = async (req, res, next) => {
  try {
    const mediaUrl = req.query.url;
    if (!mediaUrl) {
      return res.status(400).json({ success: false, message: 'Thiếu tham số url.' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(mediaUrl);
    } catch (e) {
      return res.status(400).json({ success: false, message: 'URL không hợp lệ.' });
    }

    // Thiết lập CORS header cho streaming
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Ranges, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    const range = req.headers.range;
    const forwardHeaders = {};
    if (range) {
      forwardHeaders['range'] = range;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;

    const upstreamReq = client.get(mediaUrl, { headers: forwardHeaders }, (upstreamRes) => {
      // Forward status code (206 Partial Content hoặc 200 OK)
      res.status(upstreamRes.statusCode);

      // Forward các header quan trọng cho streaming video
      if (upstreamRes.headers['content-type']) {
        res.setHeader('content-type', upstreamRes.headers['content-type']);
      } else {
        res.setHeader('content-type', 'video/mp4');
      }

      if (upstreamRes.headers['content-length']) {
        res.setHeader('content-length', upstreamRes.headers['content-length']);
      }
      if (upstreamRes.headers['content-range']) {
        res.setHeader('content-range', upstreamRes.headers['content-range']);
      }
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('cache-control', 'public, max-age=86400');

      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      console.error('[MEDIA_STREAM_ERR] Lỗi proxy stream:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ success: false, message: 'Không thể kết nối đến máy chủ lưu trữ đa phương tiện.' });
      }
    });

    // Khi người dùng tắt video hoặc chuyển tab, ngắt request upstream để tiết kiệm tài nguyên
    req.on('close', () => {
      upstreamReq.destroy();
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  streamMedia,
};
