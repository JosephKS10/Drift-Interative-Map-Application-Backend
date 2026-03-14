/**
 * SocketHandler (Module 7)
 *
 * Wires all WebSocket events to backend services.
 *
 * Events:
 *   Client → Server:
 *     chat:start     { agentId }                       → open conversation
 *     chat:message   { agentId, message, userLocation } → send message
 *     chat:end       { agentId }                       → close conversation
 *     user:move      { lat, lng }                      → user position changed
 *
 *   Server → Client:
 *     chat:response  { agentId, chunk, done }          → streamed response
 *     chat:typing    { agentId, typing }               → typing indicator
 *     agent:update   { agentId, mood, activity }       → state changed
 *     agent:wave     { agentId, message }              → nearby agent greets you
 *     gossip:new     { from, about, text }             → gossip event
 *     proximity:enter { agentId, distance, zone }      → entered agent's zone
 *     proximity:leave { agentId }                      → left agent's zone
 */

import { SocketEvents } from "../types/constants.js";
import config from "../config/index.js";

export function setupSocketHandlers(io, engine, campusData) {

  io.on("connection", (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // Per-connection state
    let userId = `user-${socket.id.substring(0, 8)}`;
    let userLocation = null;
    let activeChat = null;         // agentId currently chatting with
    let nearbyAgents = new Set();  // agents currently in proximity

    // ─── CHAT START ────────────────────────────────────────
    socket.on(SocketEvents.CHAT_START, ({ agentId }, ack) => {
      const agent = campusData.agents.find((a) => a.id === agentId);
      if (!agent) {
        if (typeof ack === "function") ack({ ok: false, error: "Agent not found" });
        return;
      }

      activeChat = agentId;
      console.log(`[Chat] ${userId} started chat with ${agent.name}`);

      // Send agent profile + relationship info
      const relationship = engine.memory.getRelationship(agentId, userId);

      if (typeof ack === "function") {
        ack({
          ok: true,
          agent: {
            id: agent.id,
            name: agent.name,
            avatar: agent.avatar,
            role: agent.role,
            mood: agent.state.mood,
            activity: agent.state.activity,
            building: agent.location.building,
          },
          relationship,
        });
      }
    });

    // ─── CHAT MESSAGE ──────────────────────────────────────
    socket.on(SocketEvents.CHAT_MESSAGE, async ({ agentId, message, userLocation: loc }) => {
      if (!message || !agentId) return;

      const agent = campusData.agents.find((a) => a.id === agentId);
      if (!agent) {
        socket.emit(SocketEvents.ERROR, { message: "Agent not found" });
        return;
      }

      // Update user location if provided
      if (loc) userLocation = loc;

      // Show typing indicator
      socket.emit(SocketEvents.CHAT_TYPING, { agentId, typing: true });

      try {
        const result = await engine.chat(agentId, userId, message, {
          userLocation,
        });

        // Send the full response
        // (For streaming, we'd use Claude's stream API — this sends it as one chunk)
        socket.emit(SocketEvents.CHAT_RESPONSE, {
          agentId,
          content: result.response,
          done: true,
          mood: result.mood,
          mentionedAgents: result.mentionedAgents,
          mentionedPlaces: result.mentionedPlaces,
          placeCards: result.placeCards || [],
          nearbyPlaces: result.nearbyPlaces || [],
          relationship: result.relationship,
        });

        // Notify about gossip events
        for (const mentionedId of result.mentionedAgents) {
          const mentioned = campusData.agents.find((a) => a.id === mentionedId);
          if (mentioned) {
            socket.emit(SocketEvents.GOSSIP_NEW, {
              from: agent.name.split(" ")[0],
              about: mentioned.name.split(" ")[0],
              agentId: agent.id,
              aboutAgentId: mentionedId,
              text: `${agent.name.split(" ")[0]} mentioned ${mentioned.name.split(" ")[0]} to you`,
            });
          }
        }

      } catch (error) {
        console.error(`[Chat] Error:`, error.message);
        socket.emit(SocketEvents.ERROR, { message: "Chat failed, try again" });
      } finally {
        socket.emit(SocketEvents.CHAT_TYPING, { agentId, typing: false });
      }
    });

    // ─── CHAT END ──────────────────────────────────────────
    socket.on(SocketEvents.CHAT_END, ({ agentId }) => {
      if (activeChat === agentId) {
        activeChat = null;
        console.log(`[Chat] ${userId} ended chat with ${agentId}`);
      }
    });

    // ─── USER MOVE (position changed on map) ───────────────
    socket.on(SocketEvents.USER_MOVE, ({ lat, lng }) => {
      if (typeof lat !== "number" || typeof lng !== "number") return;
      userLocation = { lat, lng };

      // Check proximity to all agents
      checkProximity(socket, userLocation, nearbyAgents, campusData, engine, userId);
    });

    // ─── PING (for testing) ────────────────────────────────
    socket.on("ping:test", (data, ack) => {
      if (typeof ack === "function") {
        ack({ ok: true, agents: campusData?.agents?.length || 0, timestamp: Date.now() });
      }
    });

    // ─── DISCONNECT ────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
      activeChat = null;
      nearbyAgents.clear();
    });
  });
}


/**
 * Check user proximity to all agents.
 * Emits proximity:enter / proximity:leave events when zones change.
 */
function checkProximity(socket, userLocation, nearbyAgents, campusData, engine, userId) {
  const zones = config.campus.proximityZones;

  for (const agent of campusData.agents) {
    const dist = haversineDistance(
      userLocation.lat, userLocation.lng,
      agent.location.lat, agent.location.lng
    );

    const wasNearby = nearbyAgents.has(agent.id);
    const isNearby = dist <= zones.vicinity; // 300m

    if (isNearby && !wasNearby) {
      // Entered proximity
      nearbyAgents.add(agent.id);

      const zone = dist <= zones.intimate ? "intimate" :
                   dist <= zones.nearby ? "nearby" : "vicinity";

      socket.emit(SocketEvents.PROXIMITY_ENTER, {
        agentId: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        distance: Math.round(dist),
        zone,
      });

      // If very close, agent waves
      if (dist <= zones.nearby && agent.state.proximityGreeting) {
        socket.emit("agent:wave", {
          agentId: agent.id,
          name: agent.name,
          avatar: agent.avatar,
          message: agent.state.proximityGreeting,
          distance: Math.round(dist),
        });
      }

      console.log(`[Proximity] ${userId} entered ${zone} zone of ${agent.name} (${Math.round(dist)}m)`);

    } else if (!isNearby && wasNearby) {
      // Left proximity
      nearbyAgents.delete(agent.id);
      socket.emit(SocketEvents.PROXIMITY_LEAVE, {
        agentId: agent.id,
      });
      console.log(`[Proximity] ${userId} left zone of ${agent.name}`);
    }
  }
}


function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}