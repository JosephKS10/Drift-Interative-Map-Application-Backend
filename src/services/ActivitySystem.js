/**
 * ActivitySystem (Module 9) — UPDATED
 *
 * Makes the campus feel alive even when nobody's chatting.
 *
 * Changes from v1:
 *  - Events loaded from melbourne-events.json instead of hardcoded
 *  - Events are location-aware: agents near an event mention it more
 *  - getEventsForPrompt() takes an agent param for proximity filtering
 */

import { readFile } from "fs/promises";
import { SocketEvents } from "../types/constants.js";

export class ActivitySystem {
  constructor(campusData, io) {
    this._agents = campusData.agents;
    this._io = io;
    this._intervalId = null;
    this._lastStates = new Map();
    this._events = [];  // loaded from JSON

    for (const agent of this._agents) {
      this._lastStates.set(agent.id, {
        mood: agent.state.mood,
        activity: agent.state.activity,
      });
    }

    console.log(`[Activity] System initialized for ${this._agents.length} agents`);
  }

  /**
   * Load events from JSON file.
   * Call this during server boot, after constructor.
   */
  async loadEvents(filePath) {
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw);
      this._events = data.events || [];
      console.log(`[Activity] Loaded ${this._events.length} events from ${filePath}`);
      console.log(`[Activity] Source: ${data.source || "unknown"}`);
      console.log(`[Activity] Scraped at: ${data.scrapedAt || "unknown"}`);
    } catch (err) {
      console.warn(`[Activity] Could not load events file: ${err.message}`);
      console.warn(`[Activity] Using fallback hardcoded events`);
      this._events = FALLBACK_EVENTS;
    }
  }

  /**
   * Start the periodic update loop.
   */
  start(intervalMs = 5 * 60 * 1000) {
    this.tick();
    this._intervalId = setInterval(() => this.tick(), intervalMs);
    console.log(`[Activity] Update loop started (every ${intervalMs / 1000}s)`);
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  tick() {
    const now = new Date();
    const hour = now.getHours();
    let changedCount = 0;

    for (const agent of this._agents) {
      const newState = this._getTimeBehavior(agent, hour);
      if (!newState) continue;

      const lastState = this._lastStates.get(agent.id);
      const changed = lastState.mood !== newState.mood ||
                      lastState.activity !== newState.activity;

      if (changed) {
        agent.state.mood = newState.mood;
        agent.state.activity = newState.activity;
        this._lastStates.set(agent.id, { mood: newState.mood, activity: newState.activity });

        this._io.emit(SocketEvents.AGENT_UPDATE, {
          agentId: agent.id,
          name: agent.name,
          avatar: agent.avatar,
          mood: newState.mood,
          activity: newState.activity,
          timestamp: now.toISOString(),
        });

        changedCount++;
      }
    }

    if (changedCount > 0) {
      console.log(`[Activity] ${now.toLocaleTimeString("en-AU")} — ${changedCount} agent(s) changed state`);
    }
  }

  syncAll() {
    const hour = new Date().getHours();
    let updated = 0;
    for (const agent of this._agents) {
      const state = this._getTimeBehavior(agent, hour);
      if (state) {
        agent.state.mood = state.mood;
        agent.state.activity = state.activity;
        this._lastStates.set(agent.id, { ...state });
        updated++;
      }
    }
    console.log(`[Activity] Synced ${updated} agents to current time (${new Date().toLocaleTimeString("en-AU")})`);
  }

  /**
   * Get events relevant to a specific agent, sorted by proximity.
   * Events within 5km get priority. City-wide events always included.
   *
   * @param {Object} agent - agent object with location.lat/lng
   * @param {number} maxEvents - max events to return (default 5)
   * @returns {Array} sorted events with distance
   */
  getEventsForAgent(agent, maxEvents = 5) {
    if (this._events.length === 0) return [];

    const active = this._events.filter((e) => e.active);

    // Calculate distance from agent to each event
    const withDistance = active.map((event) => {
      const dist = event.location?.lat
        ? this._haversineDistance(
            agent.location.lat, agent.location.lng,
            event.location.lat, event.location.lng
          )
        : 999999;

      return { ...event, distanceFromAgent: Math.round(dist) };
    });

    // Sort: nearby events first, then city-wide
    withDistance.sort((a, b) => a.distanceFromAgent - b.distanceFromAgent);

    return withDistance.slice(0, maxEvents);
  }

  /**
   * Get formatted events for an agent's prompt injection.
   * Location-aware: nearby events are marked as "NEARBY" so the agent
   * mentions them more naturally.
   *
   * @param {Object} agent - agent object (optional, falls back to all events)
   * @returns {string|null}
   */
  getEventsForPrompt(agent) {
    let events;

    if (agent) {
      events = this.getEventsForAgent(agent, 6);
    } else {
      events = this._events.filter((e) => e.active).slice(0, 6);
    }

    if (events.length === 0) return null;

    let ctx = "## MELBOURNE EVENTS (mention these naturally if relevant)\n";
    ctx += "Share these when someone asks what's happening or when the topic fits.\n\n";

    for (const event of events) {
      const nearby = event.distanceFromAgent && event.distanceFromAgent < 2000;
      const prefix = nearby ? "📍 NEARBY: " : "";
      ctx += `- ${prefix}${event.title}`;
      if (event.date) ctx += ` (${event.date})`;
      ctx += `: ${event.description}`;
      if (event.location?.name) ctx += ` At ${event.location.name}.`;
      if (event.time && event.time !== "Varies") ctx += ` ${event.time}.`;
      ctx += "\n";
    }

    return ctx;
  }

  /**
   * Get all active events (for API endpoint).
   */
  getActiveEvents() {
    return this._events.filter((e) => e.active);
  }

  _getTimeBehavior(agent, hour) {
    if (!agent.timeBehavior) return null;

    for (const [timeRange, state] of Object.entries(agent.timeBehavior)) {
      const [startStr, endStr] = timeRange.split("-");
      const [startH] = startStr.split(":").map(Number);
      const [endH] = endStr.split(":").map(Number);

      if (startH > endH) {
        if (hour >= startH || hour < endH) return state;
      } else {
        if (hour >= startH && hour < endH) return state;
      }
    }
    return null;
  }

  _haversineDistance(lat1, lng1, lat2, lng2) {
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

  getStats() {
    const states = {};
    for (const agent of this._agents) {
      states[agent.name] = { mood: agent.state.mood, activity: agent.state.activity };
    }
    return {
      agentStates: states,
      totalEvents: this._events.length,
      activeEvents: this._events.filter((e) => e.active).length,
    };
  }
}

// Fallback if melbourne-events.json doesn't exist
const FALLBACK_EVENTS = [
  { id: "fb-1", title: "UNIHACK hackathon this weekend", description: "At the Learning & Teaching Building, Monash Clayton", location: { name: "LTB", lat: -37.9100, lng: 145.1300, neighborhood: "Clayton" }, active: true },
  { id: "fb-2", title: "Exam period starts next Monday", description: "Library extending to 24/7", location: { name: "Campus", lat: -37.9106, lng: 145.1365, neighborhood: "Clayton" }, active: true },
];