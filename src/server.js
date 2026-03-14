import express from "express";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import { readFile } from "fs/promises";

import config from "./config/index.js";

import { AgentEngine } from "./services/AgentEngine.js";
import { setupSocketHandlers } from "./services/SocketHandler.js";
import { NeighborhoodManager } from "./services/NeighborhoodManager.js";
import { ActivitySystem } from "./services/ActivitySystem.js";

// ─── Express ────────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(compression());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// ─── Load campus data at boot ───────────────────────────────────
let campusData = null;
let placesData = null;
let gossipData = null;
let engine = null;
let neighborhood = null;  
let activity = null;    

async function loadCampusData() {
  const base = new URL(".", import.meta.url).pathname;

  const campusRaw = await readFile(base + "data/clayton-campus.json", "utf-8");
  campusData = JSON.parse(campusRaw);

  const placesRaw = await readFile(base + "data/campus-places.json", "utf-8");
  placesData = JSON.parse(placesRaw);

  const gossipRaw = await readFile(base + "data/gossip-seeds.json", "utf-8");
  gossipData = JSON.parse(gossipRaw);

  console.log(`[Data] Loaded ${campusData.agents.length} agents for ${campusData.name}`);
  console.log(`[Data] Loaded ${placesData.places.length} places + ${placesData.secretKnowledge.length} secrets`);
  console.log(`[Data] Loaded ${gossipData.storylines.length} storylines + ${gossipData.ambientGossip.length} ambient gossip`);
}



// ─── Health & Info Endpoints ────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    campus: campusData?.name || "loading...",
    agents: campusData?.agents?.length || 0,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/campus/all", (_req, res) => {
  if (!campusData) return res.status(503).json({ error: "Data loading" });

  res.json({
    id: "all",
    name: "Melbourne & Monash Clayton",
    center: { lat: -37.8136, lng: 144.9631 },
    radius: 15000,
    mapboxStyle: "mapbox://styles/mapbox/dark-v11",
    defaultZoom: 12,
    bounds: {
      north: -37.75,
      south: -37.92,
      west: 144.89,
      east: 145.15
    },
    agents: campusData.agents.map((a) => ({
      id: a.id,
      name: a.name,
      age: a.age,
      avatar: a.avatar,
      role: a.role,
      location: a.location,
      mood: a.state.mood,
      activity: a.state.activity,
    })),
  });
});

app.get("/api/campus/:campusId", (req, res) => {
  const campus = neighborhood?.getCampus(req.params.campusId);
  if (!campus) {
    return res.status(404).json({ error: "Campus not found" });
  }

  res.json({
    id: campus.campusId,
    name: campus.name,
    center: campus.center,
    radius: campus.radius,
    mapboxStyle: campus.mapboxStyle,
    defaultZoom: campus.defaultZoom,
    bounds: campus.bounds,
    agents: campus.agents.map((a) => ({
      id: a.id,
      name: a.name,
      age: a.age,
      avatar: a.avatar,
      role: a.role,
      location: a.location,
      mood: a.state.mood,
      activity: a.state.activity,
    })),
  });
});

app.get("/api/debug/places/:agentId", (req, res) => {
  const cached = engine.localKnowledge._googleCache.get(req.params.agentId);
  if (!cached) return res.json({ error: "No cache for this agent" });
  res.json(cached.places.map(p => ({ name: p.name, type: p.type, rating: p.rating })));
});

app.get("/api/agents/:id/profile", (req, res) => {
  if (!campusData) return res.status(503).json({ error: "Data loading" });

  const agent = campusData.agents.find((a) => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  res.json({
    id: agent.id,
    name: agent.name,
    age: agent.age,
    avatar: agent.avatar,
    role: agent.role,
    location: agent.location,
    personality: {
      traits: agent.personalitySeed.traits,
      occupation: agent.personalitySeed.occupation,
      backstory: agent.personalitySeed.backstory.substring(0, 200) + "...",
    },
    state: agent.state,
    relationshipCount: Object.keys(agent.relationships).length,
  });
});

app.get("/api/agents", (_req, res) => {
  if (!campusData) return res.status(503).json({ error: "Data loading" });

  res.json({
    campus: campusData.campusId,
    agents: campusData.agents.map((a) => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      role: a.role,
      building: a.location.building,
      mood: a.state.mood,
    })),
  });
});

app.get("/api/places", (_req, res) => {
  if (!placesData) return res.status(503).json({ error: "Data loading" });
  res.json(placesData);
});

app.get("/api/events", (_req, res) => {
  if (!activity) return res.status(503).json({ error: "Loading" });
  res.json({
    events: activity.getActiveEvents(),
    total: activity.getActiveEvents().length,
  });
});


app.get("/api/agents/:id/memories", (req, res) => {
  const agentId = req.params.id;
  const userId = req.headers["x-user-id"] || "anonymous";

  if (!campusData?.agents.find((a) => a.id === agentId)) {
    return res.status(404).json({ error: "Agent not found" });
  }

  res.json(engine.memory.getMemories(agentId, userId));
});

app.post("/api/agents/:id/chat", async (req, res) => {
  const { message, userLocation } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });

  const agent = campusData.agents.find((a) => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  try {
    const result = await engine.chat(
      req.params.id,
      req.headers["x-user-id"] || "anonymous",
      message,
      { userLocation }
    );
    res.json(result);
  } catch (err) {
    console.error("[Chat] Error:", err.message);
    res.status(500).json({ error: "Chat failed" });
  }
});

app.get("/api/stats", (_req, res) => {
  res.json({
    campus: campusData?.name,
    agents: campusData?.agents?.length || 0,
    places: placesData?.places?.length || 0,
    storylines: gossipData?.storylines?.length || 0,
    uptime: process.uptime(),
    ai: engine?.getStats(),
    memory: engine?.memory?.getStats(),
    gossip: engine?.gossip?.getStats(),
    localKnowledge: engine?.localKnowledge?.getStats(),
    neighborhood: neighborhood?.getStats(),
    activity: activity?.getStats(),
  });
});

// ─── Socket.IO ──────────────────────────────────────────────────
const httpServer = createServer(app);
const io = new SocketIO(httpServer, {
  cors: {
    origin: config.corsOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: 1e6,
  transports: ["websocket", "polling"],
});



// ─── Boot ───────────────────────────────────────────────────────
async function start() {
  await loadCampusData();

  try {
    const melbRaw = await readFile(
      new URL("data/melbourne-city.json", import.meta.url).pathname, "utf-8"
    );
    const melbData = JSON.parse(melbRaw);
    // Merge Melbourne agents into campusData for now
    // (NeighborhoodManager handles multi-campus properly)
    campusData.agents.push(...melbData.agents);
    console.log(`[Data] Loaded ${melbData.agents.length} Melbourne agents`);
  } catch (err) {
    console.log(`[Data] No Melbourne data found — running Clayton only`);
  }

  neighborhood = new NeighborhoodManager();
  await neighborhood.loadCampus(
    new URL("data/clayton-campus.json", import.meta.url).pathname
  );

  try {
    await neighborhood.loadCampus(
      new URL("data/melbourne-city.json", import.meta.url).pathname
    );
  } catch (err) {
    console.log(`[Neighborhood] Melbourne campus not loaded`);
  }

  activity = new ActivitySystem(campusData, io);
  await activity.loadEvents(
    new URL("data/melbourne-events.json", import.meta.url).pathname
  );
  activity.syncAll();   
  activity.start();     

   // Engine gets activity reference for event injection
  engine = new AgentEngine(campusData, placesData, gossipData, activity);

  setupSocketHandlers(io, engine, campusData);

  httpServer.listen(config.port, () => {
    console.log(`
  ╔════════════════════════════════════════════════╗
  ║           DRIFT — AI Campus Neighbors          ║
  ║────────────────────────────────────────────────║
  ║  Campus:   ${(campusData?.name || "loading").substring(0, 34).padEnd(34)}║
  ║  Agents:   ${String(campusData?.agents?.length || 0).padEnd(34)}║
  ║  Port:     ${String(config.port).padEnd(34)}║
  ║  Env:      ${config.nodeEnv.padEnd(34)}║
  ║  Model:    ${config.anthropic.model.substring(0, 34).padEnd(34)}║
  ╚════════════════════════════════════════════════╝
    `);
  });
}

start().catch((err) => {
  console.error("❌ Failed to start:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing...");
  io.close();
  httpServer.close(() => process.exit(0));
});

export { campusData, placesData, gossipData, io };
