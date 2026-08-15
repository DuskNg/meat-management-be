// meat-management-be/src/utils/socket.js
const { Server } = require('socket.io');

let io = null;

// Khởi tạo Socket.IO instance và liên kết với HTTP Server
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: '*', // Cho phép kết nối từ cả Web, Expo và Mobile App
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
  });

  io.on('connection', (socket) => {
    console.log(`[SOCKET] Client connected: ${socket.id}`);

    // Khi client kết nối và gửi yêu cầu tham gia room workspace/cửa hàng
    socket.on('join_workspace', (workspaceId) => {
      console.log(`[SOCKET] Client ${socket.id} joined workspace_${workspaceId}`);
      if (workspaceId) {
        socket.join(`workspace_${workspaceId}`);
      }
    });

    // Khi client rời room
    socket.on('leave_workspace', (workspaceId) => {
      console.log(`[SOCKET] Client ${socket.id} left workspace_${workspaceId}`);
      if (workspaceId) {
        socket.leave(`workspace_${workspaceId}`);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] Client disconnected: ${socket.id}, reason: ${reason}`);
    });
  });

  return io;
};

// Lấy instance io hiện tại
const getIO = () => {
  return io;
};

// Gửi thông báo sự kiện cập nhật tới toàn bộ các máy trong cùng Workspace
const emitWorkspaceEvent = (workspaceId, eventName, payload = {}) => {
  if (io && workspaceId) {
    io.to(`workspace_${workspaceId}`).emit(eventName, payload);
  }
};

module.exports = {
  initSocket,
  getIO,
  emitWorkspaceEvent,
};
