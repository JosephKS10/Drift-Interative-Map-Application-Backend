/**
 * NeighborhoodManager (Module 8)
 *
 * Manages campus configurations and agent lifecycle.
 *
 * Responsibilities:
 *  - Load and hold campus data
 *  - Agent lookups by ID, by location, by proximity
 *  - Proximity zone calculations
 *  - Multi-campus switching (Clayton primary, Caulfield stretch goal)
 *  - Agent state updates (mood, activity)
 */

import { readFile } from "fs/promises";
import config from "../config/index.js";

export class NeighborhoodManager {
  constructor() {
    // campusId → campus data
    this._campuses = new Map();
    this._activeCampusId = null;

    // Quick agent lookup across all campuses: agentId → { agent, campusId }
    this._agentIndex = new Map();
  }

  /**
   * Load a campus from a JSON file.
   *
   * @param {string} filePath - path to campus JSON
   * @returns {object} campus data
   */
  async loadCampus(filePath) {
    const raw = await readFile(filePath, "utf-8");
    const campus = JSON.parse(raw);

    this._campuses.set(campus.campusId, campus);

    // Index all agents for quick lookup
    for (const agent of campus.agents) {
      this._agentIndex.set(agent.id, {
        agent,
        campusId: campus.campusId,
      });
    }

    // Set as active if it's the first or the default
    if (!this._activeCampusId || campus.campusId === config.campus.defaultCampusId) {
      this._activeCampusId = campus.campusId;
    }

    console.log(`[Neighborhood] Loaded campus: ${campus.name} (${campus.agents.length} agents)`);
    return campus;
  }

  /**
   * Get the currently active campus.
   */
  getActiveCampus() {
    return this._campuses.get(this._activeCampusId) || null;
  }

  /**
   * Get a specific campus by ID.
   */
  getCampus(campusId) {
    return this._campuses.get(campusId) || null;
  }

  /**
   * Get all loaded campus IDs.
   */
  getCampusIds() {
    return [...this._campuses.keys()];
  }

  /**
   * Switch active campus.
   */
  switchCampus(campusId) {
    if (!this._campuses.has(campusId)) {
      throw new Error(`Campus not found: ${campusId}`);
    }
    this._activeCampusId = campusId;
    console.log(`[Neighborhood] Switched to campus: ${campusId}`);
    return this._campuses.get(campusId);
  }

  /**
   * Get an agent by ID (searches all campuses).
   */
  getAgent(agentId) {
    const entry = this._agentIndex.get(agentId);
    return entry?.agent || null;
  }

  /**
   * Get all agents for the active campus.
   */
  getAgents() {
    const campus = this.getActiveCampus();
    return campus?.agents || [];
  }

  /**
   * Get agents near a location, sorted by distance.
   *
   * @param {number} lat
   * @param {number} lng
   * @param {number} radiusMeters - max distance (default 500m)
   * @returns {Array<{ agent, distance, zone }>}
   */
  getAgentsNearLocation(lat, lng, radiusMeters = 500) {
    const agents = this.getAgents();
    const zones = config.campus.proximityZones;

    return agents
      .map((agent) => {
        const distance = this._haversineDistance(
          lat, lng,
          agent.location.lat, agent.location.lng
        );
        const zone =
          distance <= zones.intimate ? "intimate" :
          distance <= zones.nearby ? "nearby" :
          distance <= zones.vicinity ? "vicinity" : "far";

        return { agent, distance: Math.round(distance), zone };
      })
      .filter((entry) => entry.distance <= radiusMeters)
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Calculate proximity zone between a user location and an agent.
   *
   * @returns {{ distance: number, zone: string }}
   */
  checkProximity(userLat, userLng, agentId) {
    const agent = this.getAgent(agentId);
    if (!agent) return { distance: Infinity, zone: "far" };

    const zones = config.campus.proximityZones;
    const distance = this._haversineDistance(
      userLat, userLng,
      agent.location.lat, agent.location.lng
    );

    const zone =
      distance <= zones.intimate ? "intimate" :
      distance <= zones.nearby ? "nearby" :
      distance <= zones.vicinity ? "vicinity" : "far";

    return { distance: Math.round(distance), zone };
  }

  /**
   * Update an agent's dynamic state (mood, activity).
   */
  updateAgentState(agentId, updates) {
    const agent = this.getAgent(agentId);
    if (!agent) return false;

    if (updates.mood) agent.state.mood = updates.mood;
    if (updates.activity) agent.state.activity = updates.activity;

    return true;
  }

  /**
   * Get a summary of all agents (for the map view).
   */
  getAgentSummaries() {
    return this.getAgents().map((a) => ({
      id: a.id,
      name: a.name,
      age: a.age,
      avatar: a.avatar,
      role: a.role,
      location: a.location,
      mood: a.state.mood,
      activity: a.state.activity,
    }));
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
    return {
      campusesLoaded: this._campuses.size,
      activeCampus: this._activeCampusId,
      totalAgents: this._agentIndex.size,
    };
  }
}