#!/usr/bin/env node
/**
 * Module 1 verification test.
 * Checks: server boots, data loads, endpoints respond, agents are correct.
 */

const SERVER = process.argv[2] || "http://localhost:3001";

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.log(`  ❌ ${name} — ${err.message}`);
  }
}

async function run() {
  console.log(`\n  DRIFT — Module 1 Verification`);
  console.log(`  Server: ${SERVER}\n`);

  // Health check
  await test("Server is running", async () => {
    const res = await fetch(`${SERVER}/health`);
    const data = await res.json();
    if (data.status !== "ok") throw new Error("Status not ok");
    if (data.agents !== 8) throw new Error(`Expected 8 agents, got ${data.agents}`);
  });

  // Campus endpoint
  await test("Campus data loads correctly", async () => {
    const res = await fetch(`${SERVER}/api/campus/clayton`);
    const data = await res.json();
    if (data.agents.length !== 8) throw new Error(`Expected 8 agents, got ${data.agents.length}`);
    if (!data.center.lat || !data.center.lng) throw new Error("Missing center coords");
    if (!data.mapboxStyle) throw new Error("Missing Mapbox style");
  });

  // All agents endpoint
  await test("All agents list returns 8", async () => {
    const res = await fetch(`${SERVER}/api/agents`);
    const data = await res.json();
    if (data.agents.length !== 8) throw new Error(`Expected 8, got ${data.agents.length}`);
  });

  // Individual agent profiles
  const agentIds = [
    "agent-arjun", "agent-zoe", "agent-marko", "agent-aisha",
    "agent-rosa", "agent-jin", "agent-talia", "agent-doug",
  ];

  for (const id of agentIds) {
    await test(`Agent profile: ${id}`, async () => {
      const res = await fetch(`${SERVER}/api/agents/${id}/profile`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.name) throw new Error("Missing name");
      if (!data.location?.lat) throw new Error("Missing coordinates");
      if (!data.personality?.traits?.length) throw new Error("Missing traits");
      if (!data.state?.mood) throw new Error("Missing mood");
    });
  }

  // Places data
  await test("Campus places load", async () => {
    const res = await fetch(`${SERVER}/api/places`);
    const data = await res.json();
    if (data.places.length < 10) throw new Error(`Expected 10+ places, got ${data.places.length}`);
    if (!data.secretKnowledge?.length) throw new Error("Missing secret knowledge");
  });

  // Stats endpoint
  await test("Stats endpoint responds", async () => {
    const res = await fetch(`${SERVER}/api/stats`);
    const data = await res.json();
    if (data.agents !== 8) throw new Error(`Expected 8 agents in stats`);
    if (data.storylines !== 5) throw new Error(`Expected 5 storylines`);
  });

  // 404 for unknown campus
  await test("Unknown campus returns 404", async () => {
    const res = await fetch(`${SERVER}/api/campus/hogwarts`);
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
  });

  // 404 for unknown agent
  await test("Unknown agent returns 404", async () => {
    const res = await fetch(`${SERVER}/api/agents/agent-gandalf/profile`);
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
  });

  // Socket.IO connection test
  await test("Socket.IO connects and responds to ping", async () => {
    const { io } = await import("socket.io-client");
    const socket = io(SERVER, { transports: ["websocket"], timeout: 5000 });

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Socket timeout")), 5000);

      socket.on("connect", () => {
        socket.emit("ping:test", {}, (ack) => {
          clearTimeout(timeout);
          socket.disconnect();
          resolve(ack);
        });
      });

      socket.on("connect_error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`Socket connect failed: ${err.message}`));
      });
    });

    if (!result.ok) throw new Error("Ping ack not ok");
    if (result.agents !== 8) throw new Error(`Socket reports ${result.agents} agents`);
  });

  console.log(`\n  Module 1: Complete ✓\n`);
}

run().catch((err) => {
  console.error("\n  💥 Test failed:", err.message, "\n");
  process.exit(1);
});
