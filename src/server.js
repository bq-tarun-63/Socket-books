const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { setupWSConnection } = require("y-websocket/bin/utils");
const { Server } = require("socket.io");
const app = express();
const port = process.env.PORT || 5001;
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });
wss.on("connection", (ws, req) => {
  setupWSConnection(ws, req);
});
const io = new Server(server, {
  cors: { origin: "*" }, // adjust origin for security
});

const userConnections = new Map(); // userId -> socketId
const workspaceConnections = new Map(); // workspaceId -> Set of userIds

io.on("connection", (socket) => {
  console.log(":bell: Socket.io client connected:", socket.id);
  
  // --- Room Joining (IMPORTANT for notifications) ---
  socket.on("join-room", ({ userId, workspaceId }) => {
    if (userId) {
      // Store user connection
      console.log("📤 userId",userId);
      console.log("socket.id",socket.id);
      userConnections.set(userId, socket.id);
      socket.join(userId); // join personal room
      console.log(`:white_check_mark: User ${userId} joined personal room`);
      
      // If workspaceId is provided, join workspace room too
      if (workspaceId) {
        if (!workspaceConnections.has(workspaceId)) {
          workspaceConnections.set(workspaceId, new Set());
        }
        workspaceConnections.get(workspaceId).add(userId);
        socket.join(`workspace-${workspaceId}`);
        console.log(`:white_check_mark: User ${userId} joined workspace room: ${workspaceId}`);
      }
    }
  });

  socket.on("mention-user", (payload) => {
    console.log(payload);
    io.to(payload.sentTo[0].userEmail).emit("receive-mention",payload);
  });

  socket.on("join-request", (payload,workspaceMembers) => {
    console.log("📤 join-request", payload);
    console.log("📤 payload.workspaceId", payload.workspaceId);
  
    // Assume payload.members contains the workspace members array
    const  members  = workspaceMembers || [];
    console.log("📤 members",members);
    // Filter only owner/admin roles
    const targetMembers = members.filter(
      (m) => m.role === "owner" || m.role === "admin"
    );
    console.log("📤 targetMembers",targetMembers);
    if (targetMembers.length > 0) {

      console.log("📤 targetMembers.length",targetMembers.length);
      targetMembers.forEach((member) => {
        console.log("📤 member",member);
        console.log("📤 member.userEmail",member.userEmail);
        
        io.to(member.userEmail).emit("receive-join-request", payload);
      });
      console.log(
        `📤 Sent join request to ${targetMembers.length} owner/admin members`
      );
    } else {
      // Fallback: broadcast to all connected clients (for testing only)
      io.emit("receive-join-request", payload);
      console.log(
        "📤 Broadcasted join request to all clients (no owner/admin members found)"
      );
    }
  });

  socket.on("join-request-decision", (payload) => {
    console.log(" ✅✅✅ join-request-decision",payload)
    const userId = payload.sentTo[0]?.userEmail;
    console.log(" 📤 userId",userId);
    io.to(userId).emit("join-request-update", payload);
  });

  socket.on("mention-comment", (payload) => {

    console.log("📨 mention-comment payload:", payload);
    if(payload === null || payload === undefined) return;

    if (!payload.sentTo || !Array.isArray(payload.sentTo)) {
      console.warn("⚠️ Invalid sentTo array in mention-comment payload");
      return;
    }
  
    // Broadcast to each mentioned user by their email (personal room)
    payload.sentTo.forEach((member) => {
      if (member.userEmail) {
        console.log(`📤 Sending mention to: ${member.userEmail}`);
        io.to(member.userEmail).emit("receive-comment-mention", payload);
      }
    });
  
    console.log(`✅ Sent mention to ${payload.sentTo.length} users.`);
  });

  socket.on("new-comment", (payload) => {

    console.log("📨 new-comment payload:", payload);

    if (!payload.targetMembers || !Array.isArray(payload.targetMembers)) {
      console.warn("⚠️ Invalid targetMembers array in new-comment payload");
      return;
    }
  
    // Broadcast to each mentioned user by their email (personal room)
    payload.targetMembers.forEach((member) => {
      if (member.userEmail) {
        console.log(`📤 Sending mention to: ${member.userEmail}`);
        io.to(member.userEmail).emit("receive-new-comment", payload);
      }
    });
  
    console.log(`✅ Sent mention to ${payload.targetMembers.length} users.`);
  });
    
  socket.on("create-note-assigned",(payload)=>{
    console.log("📤 note-assigned-----",payload);
    
    if (!payload || !payload.sentTo || !Array.isArray(payload.sentTo)) {
      console.warn("⚠️ Invalid sentTo array in create-note-assigned payload");
      return;
    }
    
    const assignedMembers = payload.sentTo || [];
    console.log(assignedMembers);
    assignedMembers.forEach((member)=>{
      if (member.userEmail) {
        console.log("📤 member.userEmail",member.userEmail);
        io.to(member.userEmail).emit("receive-note-assigned",payload);
      }
    })  
  })
 
  //  socket.on("")
//  socket.on("create-note-assigned",(payload)=>{
//   console.log("📤 note-assigned-----",payload);
//   //payload is an array of members
//   payload.forEach((member)=>{
//     console.log("📤 userEmail",member);
//     io.to(member).emit("receive-note-assigned",payload);
//   })
//  })
  socket.on("create-public-note",(payload)=>{
    console.log("📤 create-public-note",payload);
    const  members  = payload.workspaceMembers || [];
    console.log(members);
    members.forEach((member)=>{
      console.log("📤 member.userEmail",member.userEmail);
      io.to(member.userEmail).emit("receive-public-note",payload);
    })
  })

  // Example: notification handler
  socket.on("send-notification", (data) => {
    console.log(":incoming_envelope: Notification received:", data);
    // Broadcast to all clients
    io.emit("receive-notification", data);
  });

  // Example: private notification
  // socket.on("send-private", ({ userId, message }) => {
  //   console.log(`:incoming_envelope: Private message to ${userId}: ${message}`);
  //   io.to(userId).emit("receive-private", message);
  // });
// note-updated is used to broadcast the note-updated event to all clients
  socket.on("note-updated", (payload) => {
    console.log("123432323453234",payload,"fsdfhasdkjfjasdfjasdkfjasddfjdsfjlksdfljkasdfljkdfljk;kasdflkjjdsljkasdfjksdflkjsadflkjasdflkjsdlkjsadflkjdljkasdfjkl");
    if (!payload?.noteId || !payload?.dataSourceId) {

      console.warn("note-updated missing payload:", payload);
      return;
    }
    console.log("note-updated broadcast:", payload);
    io.emit("note-updated", payload);
  });
  // --- 7. Debug endpoint ---
  socket.on("get-connections", () => {
    const debugInfo = {
      totalUsers: userConnections.size,
      totalWorkspaces: workspaceConnections.size,
      workspaces: Object.fromEntries(
        Array.from(workspaceConnections.entries()).map(([id, users]) => [
          id, 
          Array.from(users)
        ])
      )
    };
    socket.emit("connections-debug", debugInfo);
    console.log("🔍 Debug info requested:", debugInfo);
  });

  socket.on("disconnect", () => {
    console.log(":x: Socket.io client disconnected:", socket.id);
    
    // Clean up user connections
    for (const [userId, socketId] of userConnections.entries()) {
      if (socketId === socket.id) {
        userConnections.delete(userId);
        console.log(`:x: Cleaned up connection for user ${userId}`);
        break;
      }
    }
    
    // Clean up workspace connections
    for (const [workspaceId, users] of workspaceConnections.entries()) {
      for (const userId of users) {
        if (userConnections.get(userId) === socket.id) {
          users.delete(userId);
          console.log(`:x: User ${userId} removed from workspace ${workspaceId}`);
          if (users.size === 0) {
            workspaceConnections.delete(workspaceId);
            console.log(`:x: Workspace ${workspaceId} removed (no users left)`);
          }
          break;
        }
      }
    }
  });
});

// Health check endpoint
app.get("/", (_req, res) => {
  res.send(":white_check_mark: Yjs + Socket.io WebSocket Server Running");
});

// Debug endpoint
app.get("/debug", (_req, res) => {
  const debugInfo = {
    totalUsers: userConnections.size,
    totalWorkspaces: workspaceConnections.size,
    workspaces: Object.fromEntries(
      Array.from(workspaceConnections.entries()).map(([id, users]) => [
        id, 
        Array.from(users)
      ])
    )
  };
  res.json(debugInfo);
});

server.listen(port, () => {
  console.log(`:white_check_mark: Yjs server running at ws://localhost:${port}`);
  console.log(`   - Yjs on ws://localhost:${port}`);
  console.log(`   - Socket.io on http://localhost:${port}/socket.io-notifications`);
  console.log(`   - Debug endpoint: http://localhost:${port}/debug`);
});