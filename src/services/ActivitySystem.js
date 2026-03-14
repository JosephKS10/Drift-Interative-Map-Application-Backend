/**
 * ActivitySystem (Module 9)
 *
 * Makes the campus feel alive even when nobody's chatting.
 *
 * Responsibilities:
 *  - Update agent mood/activity based on time of day
 *  - Broadcast state changes to connected clients
 *  - Inject campus events into agent awareness
 *
 * Runs on a 5-minute interval. Each tick:
 *  1. Get current hour
 *  2. For each agent, look up their timeBehavior schedule
 *  3. If their state has changed, update it and broadcast
 */

import { SocketEvents } from "../types/constants.js";

// Campus-wide events that agents can reference in conversation
const CAMPUS_EVENTS = [
  { text: "UNIHACK hackathon this weekend at the Learning & Teaching Building", active: true },
  { text: "Exam period starts next Monday — library extending to 24/7", active: true },
  { text: "New GYG opened at Campus Centre — students are losing their minds", active: true },
  { text: "Marko's 6am boot camp — every weekday at Monash Sport, first session free", recurring: true },
  { text: "International food night this Thursday at the Campus Centre", active: true },
  { text: "Alexander Theatre showing student films Friday afternoon", active: true },
];

export class ActivitySystem {
  constructor(campusData, io) {
    this._agents = campusData.agents;
    this._io = io;
    this._intervalId = null;
    this._lastStates = new Map(); // agentId → { mood, activity }

    // Store initial states
    for (const agent of this._agents) {
      this._lastStates.set(agent.id, {
        mood: agent.state.mood,
        activity: agent.state.activity,
      });
    }

    console.log(`[Activity] System initialized for ${this._agents.length} agents`);
  }

  /**
   * Start the periodic update loop.
   * Checks every intervalMs (default 5 minutes) and broadcasts changes.
   */
  start(intervalMs = 5 * 60 * 1000) {
    // Run immediately on start
    this.tick();

    // Then run periodically
    this._intervalId = setInterval(() => this.tick(), intervalMs);
    console.log(`[Activity] Update loop started (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop the update loop.
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      console.log(`[Activity] Update loop stopped`);
    }
  }

  /**
   * Single update tick. Check time, update agents, broadcast changes.
   */
  tick() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    let changedCount = 0;

    for (const agent of this._agents) {
      const newState = this._getTimeBehavior(agent, hour);
      if (!newState) continue;

      const lastState = this._lastStates.get(agent.id);
      const changed = lastState.mood !== newState.mood ||
                      lastState.activity !== newState.activity;

      if (changed) {
        // Update the agent's live state
        agent.state.mood = newState.mood;
        agent.state.activity = newState.activity;

        // Store for next comparison
        this._lastStates.set(agent.id, {
          mood: newState.mood,
          activity: newState.activity,
        });

        // Broadcast to all connected clients
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

  /**
   * Force update all agents to current time state.
   * Useful after server restart to sync state with clock.
   */
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
   * Get active campus events for prompt injection.
   * Returns events that agents might mention in conversation.
   */
  static getActiveEvents() {
    return CAMPUS_EVENTS.filter((e) => e.active || e.recurring);
  }

  /**
   * Get formatted events for prompt injection.
   */
  static getEventsForPrompt() {
    const events = ActivitySystem.getActiveEvents();
    if (events.length === 0) return null;

    let ctx = "## CAMPUS EVENTS (mention these naturally if relevant)\n";
    for (const event of events) {
      ctx += `- ${event.text}\n`;
    }
    return ctx;
  }

  /**
   * Look up time-based behavior from agent's schedule.
   */
  _getTimeBehavior(agent, hour) {
    if (!agent.timeBehavior) return null;

    for (const [timeRange, state] of Object.entries(agent.timeBehavior)) {
      const [startStr, endStr] = timeRange.split("-");
      const [startH] = startStr.split(":").map(Number);
      const [endH] = endStr.split(":").map(Number);

      if (startH > endH) {
        // Overnight range (e.g., 22:00-06:00)
        if (hour >= startH || hour < endH) return state;
      } else {
        if (hour >= startH && hour < endH) return state;
      }
    }
    return null;
  }

  getStats() {
    const states = {};
    for (const agent of this._agents) {
      states[agent.name] = { mood: agent.state.mood, activity: agent.state.activity };
    }
    return { agentStates: states, eventsActive: CAMPUS_EVENTS.filter((e) => e.active).length };
  }
}