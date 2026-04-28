const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { setupWSConnection } = require("y-websocket/bin/utils");
const { Server } = require("socket.io");

const app = express();
const port = process.env.PORT || 5001;
const server = http.createServer(app);

// --- INTERNAL SECRET ---
// Next.js Backend uses this header to authenticate HTTP calls to this server.
// Must match SOCKET_INTERNAL_SECRET in Next.js .env
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "dev-secret";

// --- YJS WebSocket (for future collaborative editing) ---
// Use noServer:true so the raw ws server does NOT intercept all upgrade requests.
// Without this, ws grabs socket.io's WebSocket upgrades too, causing "websocket error".
// We manually forward only non-socket.io paths to Yjs here.
const wss = new WebSocket.Server({ noServer: true });
wss.on("connection", (ws, req) => {
  setupWSConnection(ws, req);
});

// Route WebSocket upgrade requests:
//   /socket.io/* → handled by socket.io (do nothing here, it hooks its own listener)
//   everything else → Yjs collaborative editing
server.on("upgrade", (request, socket, head) => {
  if (request.url && request.url.startsWith("/socket.io")) {
    // socket.io manages its own upgrade — do not intercept
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// --- SOCKET.IO ---
const io = new Server(server, {
  cors: { origin: "*" },
});

// userId → socketId  (for disconnect cleanup only)
const userConnections = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO CONNECTION HANDLER
// ─────────────────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`\n[SocketServer] 🔌 New connection: ${socket.id}`);

  // ─── PERSONAL ROOM JOIN ───────────────────────────────────────────────────
  // Triggered by: Browser → socket.emit("join-room", { userId, email })
  // Room name = email  ← this is what Next.js API targets in server-ping
  // userId is stored only for disconnect cleanup
  socket.on("join-room", ({ userId, email }) => {
    console.log(
      `\n[SocketServer] 📥 join-room received`,
      `\n  socketId : ${socket.id}`,
      `\n  userId   : ${userId || "N/A"}`,
      `\n  email    : ${email || "N/A"}`,
    ); 

    if (!email) {
      console.warn(`[SocketServer] ⚠ join-room rejected — no email provided (socketId: ${socket.id})`);
      return;
    }

    // Store userId → socketId for cleanup on disconnect
    if (userId) {
      userConnections.set(userId, socket.id);
    }

    // Join personal room identified by email
    // This is the room that Next.js targets via: targets: ["bob@email.com"]
    socket.join(email);
    console.log(`[SocketServer] ✅ ${email} joined personal room "${email}" (socketId: ${socket.id})`);
  });

  // ─── SERVER-PING → CLIENT-PING ────────────────────────────────────────────
  // Triggered by: Next.js Backend → emitServerEvent("server-ping", { targets, actionType, ... })
  // This is the MISSING HANDLER that was causing all events to silently drop.
  // Flow: Next.js API → server-ping → Socket Server → client-ping → Browser
  socket.on("server-ping", (payload) => {
    const { targets = [], actionType, noteId, workspaceId, ...rest } = payload;

    console.log(
      `\n[SocketServer] 📨 server-ping received`,
      `\n  actionType  : ${actionType || "N/A"}`,
      `\n  targets     : ${JSON.stringify(targets)}`,
      `\n  noteId      : ${noteId || "N/A"}`,
      `\n  workspaceId : ${workspaceId || "N/A"}`,
    );

    if (!targets || targets.length === 0) {
      console.warn(`[SocketServer] ⚠ server-ping has no targets — nothing to deliver (actionType: ${actionType})`);
      return;
    }

    // Fan-out to each target's personal room (room name = email)
    // Each target's browser will receive "client-ping" in notificationSocketListner.tsx
    let delivered = 0;
    targets.forEach((email) => {
      if (!email) return;

      const roomSockets = io.sockets.adapter.rooms.get(email);
      const isOnline = roomSockets && roomSockets.size > 0;

      console.log(
        `[SocketServer] 📤 → ${email}`,
        isOnline
          ? `(online — ${roomSockets.size} socket(s))`
          : `(offline — no active socket in room "${email}")`,
      );

      // Emit client-ping to personal room
      // Browser receives this in notificationSocketListner.tsx → handleClientPing()
      io.to(email).emit("client-ping", { actionType, noteId, workspaceId, ...rest });
      if (isOnline) delivered++;
    });

    console.log(
      `[SocketServer] ✅ server-ping → client-ping delivered`,
      `\n  actionType : ${actionType}`,
      `\n  total      : ${targets.length} target(s)`,
      `\n  online     : ${delivered} delivered immediately`,
      `\n  offline    : ${targets.length - delivered} missed (user not connected)`,
    );
  });

  // ─── LEAVE WORKSPACE ROOM ─────────────────────────────────────────────────
  // Triggered by: Browser → socket.emit("leave-workspace", { workspaceId })
  // Called when user switches workspace without disconnecting
  socket.on("leave-workspace", ({ workspaceId }) => {
    if (!workspaceId) return;
    const wsRoom = `ws:${workspaceId}`;
    const adminRoom = `ws:${workspaceId}:admins`;
    socket.leave(wsRoom);
    socket.leave(adminRoom);
    console.log(`[SocketServer] 🚪 Socket ${socket.id} left rooms: ${wsRoom}, ${adminRoom}`);
  });

  // ─── WORKSPACE ROOM BROADCAST ─────────────────────────────────────────────
  // Triggered by: HTTP POST /internal/emit from Next.js Backend
  // Emits an event to ALL users in a workspace room at once (O(1) broadcast)
  // Used for: PUBLIC_PAGE, NEW_COMMENT when moving to hybrid room approach
  socket.on("ws-broadcast", ({ workspaceId, actionType, ...rest }) => {
    if (!workspaceId) return;
    const room = `ws:${workspaceId}`;
    console.log(
      `\n[SocketServer] 📢 ws-broadcast`,
      `\n  room       : ${room}`,
      `\n  actionType : ${actionType}`,
    );
    io.to(room).emit("client-ping", { actionType, workspaceId, ...rest });
  });

  // ─── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`\n[SocketServer] ❌ Disconnected: ${socket.id} (reason: ${reason})`);

    // Remove from userConnections Map
    for (const [userId, socketId] of userConnections.entries()) {
      if (socketId === socket.id) {
        userConnections.delete(userId);
        console.log(`[SocketServer] 🧹 Cleaned up userId="${userId}" from connections map`);
        break;
      }
    }
    // Note: Socket.IO automatically removes the socket from all rooms on disconnect
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP ENDPOINTS (called by Next.js Backend, not browsers)
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());

// Middleware: verify internal secret on all /internal/* routes
const verifyInternalSecret = (req, res, next) => {
  const secret = req.headers["x-internal-secret"];
  if (secret !== INTERNAL_SECRET) {
    console.warn(
      `[SocketServer] 🚫 Unauthorized /internal request`,
      `\n  path     : ${req.path}`,
      `\n  ip       : ${req.ip}`,
    );
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

// POST /internal/force-join
// Called by: Next.js /api/socket/join after verifying workspace membership in MongoDB
// Purpose: force a specific socket into the workspace room (ws:{workspaceId})
//          and personal room (email) — after Next.js has confirmed the user is a valid member
app.post("/internal/force-join", verifyInternalSecret, (req, res) => {
  const { socketId, workspaceId, role, email } = req.body;

  console.log(
    `\n[SocketServer] 🔑 /internal/force-join`,
    `\n  socketId    : ${socketId}`,
    `\n  workspaceId : ${workspaceId}`,
    `\n  email       : ${email}`,
    `\n  role        : ${role}`,
  );

  if (!socketId || !workspaceId || !email) {
    console.warn(`[SocketServer] ⚠ force-join missing required fields`);
    return res.status(400).json({ error: "socketId, workspaceId, and email are required" });
  }

  // Find the target socket by socketId
  // This works because Next.js calls us with the exact socketId the browser reported
  const targetSocket = io.sockets.sockets.get(socketId);

  if (!targetSocket) {
    // Socket disconnected between the browser's API call and this force-join
    console.warn(
      `[SocketServer] ⚠ Socket not found for socketId="${socketId}" — user may have disconnected`,
      `\n  email       : ${email}`,
      `\n  workspaceId : ${workspaceId}`,
    );
    return res.status(404).json({ error: "Socket not found — user may have disconnected" });
  }

  // Join workspace broadcast room — all workspace events go here
  // Next.js can emit to ws:{workspaceId} to reach ALL members at once (no DB query needed)
  const wsRoom = `ws:${workspaceId}`;
  targetSocket.join(wsRoom);
  console.log(`[SocketServer] ✅ ${email} joined workspace room "${wsRoom}"`);

  // Admins and owners also join the admins room for JOIN_REQUEST events
  if (role === "admin" || role === "owner") {
    const adminRoom = `ws:${workspaceId}:admins`;
    targetSocket.join(adminRoom);
    console.log(`[SocketServer] ✅ ${email} joined admin room "${adminRoom}" (role: ${role})`);
  }

  // Also ensure personal room is joined (in case join-room was missed)
  targetSocket.join(email);
  console.log(`[SocketServer] ✅ ${email} personal room "${email}" confirmed`);

  // Log current rooms for this socket for debugging
  const currentRooms = Array.from(targetSocket.rooms);
  console.log(`[SocketServer] 📋 ${email} is now in rooms:`, currentRooms);

  return res.json({ ok: true, rooms: currentRooms });
});

// POST /internal/emit
// Called by: Next.js Backend to broadcast to a workspace room
// Purpose: Next.js can call this instead of emitServerEvent for workspace-level broadcasts
// This is faster than emitServerEvent (no socket connection overhead)
app.post("/internal/emit", verifyInternalSecret, (req, res) => {
  const { room, event = "client-ping", data } = req.body;

  console.log(
    `\n[SocketServer] 📡 /internal/emit`,
    `\n  room       : ${room}`,
    `\n  event      : ${event}`,
    `\n  actionType : ${data?.actionType || "N/A"}`,
  );

  if (!room || !data) {
    return res.status(400).json({ error: "room and data are required" });
  }

  const roomSockets = io.sockets.adapter.rooms.get(room);
  const memberCount = roomSockets ? roomSockets.size : 0;
  console.log(`[SocketServer] 📢 Broadcasting to room "${room}" — ${memberCount} socket(s) currently in room`);

  io.to(room).emit(event, data);
  console.log(`[SocketServer] ✅ Emitted "${event}" to room "${room}"`);

  return res.json({ ok: true, membersInRoom: memberCount });
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK & DEBUG
// ─────────────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send("✅ Socket Server Running");
});

app.get("/debug", (_req, res) => {
  const rooms = {};
  for (const [roomName, socketSet] of io.sockets.adapter.rooms.entries()) {
    // Skip the default per-socket rooms (named by socketId)
    if (socketSet.size > 0 && !io.sockets.sockets.has(roomName)) {
      rooms[roomName] = Array.from(socketSet);
    }
  }

  const debugInfo = {
    totalConnections: io.sockets.sockets.size,
    trackedUsers: userConnections.size,
    rooms,
  };

  console.log(`\n[SocketServer] 🔍 /debug requested:`, JSON.stringify(debugInfo, null, 2));
  res.json(debugInfo);
});

server.listen(port, () => {
  console.log(`\n✅ Socket Server running on port ${port}`);
  console.log(`   Socket.IO  : http://localhost:${port}`);
  console.log(`   Debug      : http://localhost:${port}/debug`);
  console.log(`   Force-join : POST http://localhost:${port}/internal/force-join`);
  console.log(`   Emit       : POST http://localhost:${port}/internal/emit`);
});
