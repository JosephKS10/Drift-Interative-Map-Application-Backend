#!/usr/bin/env node
/**
 * Module 7 socket test — verifies real-time chat and proximity events.
 */
import { io } from "socket.io-client";

const SERVER = process.argv[2] || "http://localhost:3001";
const socket = io(SERVER, { transports: ["websocket"] });

socket.on("connect", async () => {
  console.log(`✅ Connected: ${socket.id}\n`);

  // 1. Start chat with Arjun
  socket.emit("chat:start", { agentId: "agent-arjun" }, (ack) => {
    console.log(`📋 Chat started:`, ack.ok ? `${ack.agent.name} (${ack.agent.mood})` : ack.error);
  });

  // 2. Listen for typing and response
  socket.on("chat:typing", ({ agentId, typing }) => {
    if (typing) console.log(`⏳ Agent is typing...`);
  });

  socket.on("chat:response", ({ content, mood, mentionedAgents, relationship }) => {
    console.log(`\n💬 Response (mood: ${mood}):`);
    console.log(`   "${content.substring(0, 150)}${content.length > 150 ? '...' : ''}"`);
    console.log(`   Mentioned: [${mentionedAgents.join(", ") || "none"}]`);
    console.log(`   Relationship: ${relationship}`);
  });

  // 3. Listen for gossip events
  socket.on("gossip:new", ({ from, about, text }) => {
    console.log(`\n🗣️  Gossip: ${text}`);
  });

  // 4. Listen for proximity events
  socket.on("proximity:enter", ({ agentId, name, distance, zone }) => {
    console.log(`\n📍 Proximity: entered ${zone} zone of ${name} (${distance}m)`);
  });

  socket.on("agent:wave", ({ name, message }) => {
    console.log(`👋 ${name} waves: "${message}"`);
  });

  socket.on("proximity:leave", ({ agentId }) => {
    console.log(`📍 Left zone of ${agentId}`);
  });

  // 5. Send a message
  await sleep(500);
  console.log(`\n📝 Sending: "What do you think of the other people on campus?"\n`);
  socket.emit("chat:message", {
    agentId: "agent-arjun",
    message: "What do you think of the other people on campus?",
  });

  // 6. After response arrives, test proximity
  await sleep(8000);
  console.log(`\n── Testing Proximity ──`);

  // Move near the library (Arjun's location)
  console.log(`📍 Moving to library entrance...`);
  socket.emit("user:move", { lat: -37.9113, lng: 145.1320 });

  await sleep(1000);

  // Move to IT building (Zoe's location)
  console.log(`📍 Moving to IT building...`);
  socket.emit("user:move", { lat: -37.9083, lng: 145.1379 });

  await sleep(1000);

  // Move far away
  console.log(`📍 Moving far away...`);
  socket.emit("user:move", { lat: -37.9200, lng: 145.1500 });

  await sleep(2000);

  console.log(`\n✅ Test complete`);
  socket.disconnect();
  process.exit(0);
});

socket.on("connect_error", (err) => {
  console.error(`❌ Connection failed: ${err.message}`);
  process.exit(1);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}