const http = require('http');
const { WebSocketServer } = require('ws');

const port = process.env.PORT || 3000;
const rooms = new Map(); // roomCode -> { active, members: Map, chat: [], disconnectTimers: Map }
const clients = new Map(); // ws -> { room, userId }
const REJOIN_GRACE_MS = 15000; // 15 seconds to reconnect before being removed

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/plain'
  });
  res.end('StudyBeast relay v3 running. Rooms: ' + rooms.size);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(ws, msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info && info.room) {
      const room = rooms.get(info.room);
      if (room) {
        // Start a grace period instead of removing immediately
        if (!room.disconnectTimers) room.disconnectTimers = new Map();
        const timer = setTimeout(() => {
          // Only remove if they haven't reconnected
          if (room.disconnectTimers && room.disconnectTimers.get(info.userId) === timer) {
            room.disconnectTimers.delete(info.userId);
            room.members.delete(info.userId);
            broadcast(info.room, { type: 'members', members: Object.fromEntries(room.members) });
            broadcast(info.room, { type: 'chat', id: 'sys_' + Date.now(), msg: { sys: true, text: (info.name || 'Someone') + ' left the room', ts: Date.now() } });
            if (room.members.size === 0) rooms.delete(info.room);
          }
        }, REJOIN_GRACE_MS);
        room.disconnectTimers.set(info.userId, timer);
      }
    }
    clients.delete(ws);
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const code = msg.code;
      rooms.set(code, { active: true, members: new Map(), chat: [], disconnectTimers: new Map() });
      const room = rooms.get(code);
      room.members.set(msg.userId, msg.status);
      clients.set(ws, { room: code, userId: msg.userId, name: msg.status.name });
      ws.send(JSON.stringify({ type: 'created', code }));
      broadcast(code, { type: 'members', members: Object.fromEntries(room.members) });
      break;
    }
    case 'join': {
      const code = msg.code;
      const room = rooms.get(code);
      if (!room || !room.active) {
        ws.send(JSON.stringify({ type: 'error', msg: 'Room not found' }));
        return;
      }
      // Cancel disconnect timer if this is a rejoin
      const isRejoin = room.disconnectTimers && room.disconnectTimers.has(msg.userId);
      if (isRejoin) {
        clearTimeout(room.disconnectTimers.get(msg.userId));
        room.disconnectTimers.delete(msg.userId);
      }
      room.members.set(msg.userId, msg.status);
      clients.set(ws, { room: code, userId: msg.userId, name: msg.status.name });
      ws.send(JSON.stringify({ type: 'joined', code }));
      // Send existing chat history (last 50)
      const recentChat = room.chat.slice(-50);
      recentChat.forEach(c => ws.send(JSON.stringify({ type: 'chat', id: c.id, msg: c.msg })));
      // Broadcast updated members
      broadcast(code, { type: 'members', members: Object.fromEntries(room.members) });
      // Only broadcast join message if not a rejoin
      if (!isRejoin) {
        const chatMsg = { sys: true, text: msg.status.name + ' joined the room', ts: Date.now() };
        const chatId = 'sys_' + Date.now() + '_' + msg.userId;
        room.chat.push({ id: chatId, msg: chatMsg });
        broadcast(code, { type: 'chat', id: chatId, msg: chatMsg });
      }
      break;
    }
    case 'status': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.room);
      if (!room) return;
      room.members.set(info.userId, msg.status);
      broadcast(info.room, { type: 'members', members: Object.fromEntries(room.members) });
      break;
    }
    case 'chat': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.room);
      if (!room) return;
      const chatId = 'msg_' + Date.now() + '_' + info.userId;
      const chatMsg = { name: msg.name, text: msg.text, color: msg.color, from: info.userId, ts: Date.now() };
      room.chat.push({ id: chatId, msg: chatMsg });
      // Keep only last 200 messages
      if (room.chat.length > 200) room.chat = room.chat.slice(-200);
      broadcast(info.room, { type: 'chat', id: chatId, msg: chatMsg }, ws);
      break;
    }
    case 'leave': {
      const info = clients.get(ws);
      if (!info) return;
      const room = rooms.get(info.room);
      if (room) {
        room.members.delete(info.userId);
        broadcast(info.room, { type: 'members', members: Object.fromEntries(room.members) });
        broadcast(info.room, { type: 'chat', id: 'sys_' + Date.now(), msg: { sys: true, text: (info.name || 'Someone') + ' left the room', ts: Date.now() } });
        if (room.members.size === 0) rooms.delete(info.room);
      }
      clients.delete(ws);
      break;
    }
  }
}

function broadcast(roomCode, data, excludeWs) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    const info = clients.get(ws);
    if (info && info.room === roomCode && ws !== excludeWs && ws.readyState === 1) {
      ws.send(payload);
    }
  });
}

server.listen(port, () => {
  console.log('StudyBeast relay v2 running on port ' + port);
});
