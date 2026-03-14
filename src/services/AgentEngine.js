import Anthropic from "@anthropic-ai/sdk";
import config from "../config/index.js";
import { generatePrompt, estimateTokens } from "./PersonalityEngine.js";
import { ProximityZone } from "../types/constants.js";
import { MemoryManager } from "./MemoryManager.js";
import { LocalKnowledge } from "./LocalKnowledge.js";
import { GossipEngine } from "./GossipEngine.js";

/**
 * AgentEngine (Module 3)
 *
 * The core brain. Assembles the 5-layer prompt and calls Claude.
 *
 * Layer 1: Personality  (static, CACHED with Layer 2)
 * Layer 2: Relationships (static, CACHED with Layer 1)
 * Layer 3: Local knowledge (refreshed — injected per call)
 * Layer 4: User memory (per conversation — injected per call)
 * Layer 5: Current context (time, proximity, mood — injected per call)
 *
 * Layers 1+2 come from PersonalityEngine.generatePrompt() and are
 * sent as a cached system block. Layers 3-5 are the user message prefix.
 */
export class AgentEngine {
  constructor(campusData, placesData, gossipData, activitySystem) {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
    this.campusData = campusData;
    this.placesData = placesData;
    this.gossipData = gossipData;
    this.activity = activitySystem || null;

    // Pre-generate and cache all personality prompts at boot
    this.personalityPrompts = new Map();
    for (const agent of campusData.agents) {
      const prompt = generatePrompt(agent);
      this.personalityPrompts.set(agent.id, prompt);
      console.log(
        `[Engine] ${agent.name.padEnd(22)} → ${estimateTokens(prompt)} tokens (L1+L2)`
      );
    }

      // Local knowledge service (Module 5)
    this.localKnowledge = new LocalKnowledge(placesData);

    this.gossip = new GossipEngine(gossipData, campusData);

    // In-memory conversation memory (Module 4 will replace this)
    // Structure: "agentId:userId" → Array<{ summary, timestamp, topics }>
   this.memory = new MemoryManager();

    // Stats tracking
    this.stats = {
      totalCalls: 0,
      totalErrors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }

   /**
   * Get all cached places near this agent that AREN'T already in placeCards.
   * Sent to frontend as "more places to explore."
   */
  _getNearbyPlaces(agent, excludeCards) {
    const excludeIds = new Set(excludeCards.map((c) => c.id));
    const nearby = [];

    // Hardcoded places near this agent
    if (this.placesData?.places) {
      for (const place of this.placesData.places) {
        if (excludeIds.has(place.id)) continue;
        const dist = this._haversineDistance(
          agent.location.lat, agent.location.lng,
          place.lat, place.lng
        );
        if (dist <= 5000) {
          nearby.push(this._formatPlaceCard({
            ...place,
            distance: Math.round(dist),
            photoUrl: null,
            website: null,
            isOpen: null,
            source: "campus",
          }));
        }
      }
    }

    // Google cached places for this agent
    const cached = this.localKnowledge._googleCache.get(agent.id);
    if (cached?.places) {
      for (const place of cached.places) {
        if (excludeIds.has(place.id)) continue;
        if (nearby.some((n) => n.id === place.id)) continue;
        nearby.push(this._formatPlaceCard({
          ...place,
          distance: Math.round(this._haversineDistance(
            agent.location.lat, agent.location.lng,
            place.lat, place.lng
          )),
        }));
      }
    }

    // Sort by rating (best first), then distance
    nearby.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (a.distance || 0) - (b.distance || 0));

    return nearby.slice(0, 10);
  }

  /**
   * Main entry: chat with an agent.
   *
   * @param {string} agentId
   * @param {string} userId
   * @param {string} message - what the user said
   * @param {object} options
   * @param {object} options.userLocation - { lat, lng } for proximity calc
   * @returns {object} { response, mood, mentionedAgents, mentionedPlaces, memoryUpdate }
   */
  async chat(agentId, userId, message, options = {}) {
    const startTime = Date.now();
    const agent = this.campusData.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    try {
      // ── Get the cached personality prompt (Layers 1+2) ──
      const systemPrompt = this.personalityPrompts.get(agentId);

      // ── Build dynamic context (Layers 3+4+5) ──
      const dynamicContext = await this._buildDynamicContext(agent, userId, message, options);

      // ── Call Claude ──
      this.stats.totalCalls++;
      console.log(`[Engine] Call #${this.stats.totalCalls}: ${agent.name} ← "${message.substring(0, 50)}..."`);

      const response = await this.client.messages.create({
        model: config.anthropic.model,
        max_tokens: config.anthropic.maxTokens,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: dynamicContext + "\n\n" + message,
          },
        ],
      });

      const latency = Date.now() - startTime;
      this._trackUsage(response.usage);

      console.log(
        `[Engine] Response in ${latency}ms | ` +
        `In: ${response.usage?.input_tokens || "?"} | ` +
        `Out: ${response.usage?.output_tokens || "?"} | ` +
        `Cache write: ${response.usage?.cache_creation_input_tokens || 0} | ` +
        `Cache read: ${response.usage?.cache_read_input_tokens || 0}`
      );

      // ── Extract response text ──
      const responseText = response.content?.[0]?.text || "";

      // ── Store memory of this exchange ──
       const memResult = this.memory.store(
        agentId, userId, message, responseText, agent.name
      );

      // ── Detect mentioned agents and places ──
      const mentionedAgents = this._detectAgentMentions(responseText, agentId);
      const mentionedPlaces = this._detectPlaceMentions(responseText);

      const placeCards = [];
      const nearbyPlaces = this._getNearbyPlaces(agent, placeCards);

      for (const placeId of mentionedPlaces) {
        const placeData = this.localKnowledge.getPlaceById(placeId, agent);
        if (placeData) {
          placeCards.push({
            id: placeData.id,
            name: placeData.name,
            type: placeData.type,
            lat: placeData.lat,
            lng: placeData.lng,
            rating: placeData.rating,
            ratingCount: placeData.ratingCount || null,
            address: placeData.address || null,
            description: placeData.description,
            insiderTip: placeData.insiderTip || null,
            photoUrl: placeData.photoUrl || null,
            website: placeData.website || null,
            isOpen: placeData.isOpen,
            distance: placeData.distance,
            source: placeData.source,
          });
        }
      }

       // ── Record gossip: agent mentioned other agents ──
      for (const mentionedId of mentionedAgents) {
        const mentionedAgent = this.campusData.agents.find((a) => a.id === mentionedId);
        if (mentionedAgent) {
          // Extract what was said about them (brief snippet from response)
          const snippet = this._extractMentionContext(responseText, mentionedAgent.name);
          this.gossip.recordMention(agentId, mentionedId, userId, snippet);
        }
      }

        // ── Check if user mentioned any agents in their message ──
      const userMentionedAgents = this._detectAgentMentions(message, agentId);
      for (const mentionedId of userMentionedAgents) {
        this.gossip.recordUserMention(agentId, mentionedId, userId, message);
      }

     return {
        response: responseText,
        mood: agent.state.mood,
        mentionedAgents,
        mentionedPlaces,
        placeCards,
        nearbyPlaces,
        memoryUpdate: memResult.summary,
        relationship: memResult.relationshipScore,
        latencyMs: latency,
      };
    } catch (error) {
      this.stats.totalErrors++;
      console.error(`[Engine] Error for ${agent.name}:`, error.message);

      if (error.status === 429) {
        return {
          response: `*${agent.name.split(" ")[0]} seems distracted right now. Try again in a moment.*`,
          mood: agent.state.mood,
          mentionedAgents: [],
          mentionedPlaces: [],
          memoryUpdate: null,
          latencyMs: Date.now() - startTime,
        };
      }

      throw error;
    }
  }

  /**
   * Build Layers 3+4+5 as a context prefix for the user message.
   * This is NOT cached — it changes every call.
   */
  async _buildDynamicContext(agent, userId, message, options) {
    const parts = [];

    // ── Layer 3: Local Knowledge ──
    const nearbyPlaces = await this._getAgentLocalKnowledge(agent);
    if (nearbyPlaces) {
      parts.push(nearbyPlaces);
    }

    // ── Layer 4: User Memory ──
    const memories = this._getRelevantMemories(agent.id, userId, message);
    if (memories) {
      parts.push(memories);
    }

    const gossipAbout = this.gossip.getGossipForPrompt(agent.id, userId);
    if (gossipAbout) {
      parts.push(gossipAbout);
    }

    // ── Layer 4c: Agent's own gossip knowledge ──
    const agentGossip = this.gossip.getAgentKnowledgeForPrompt(agent.id);
    if (agentGossip) {
      parts.push(agentGossip);
    }

    const events = this.activity.getEventsForPrompt(agent);
    if (events) {
      parts.push(events);
    }

    // ── Layer 5: Current Context ──
    const context = this._buildCurrentContext(agent, options);
    parts.push(context);

    return parts.join("\n\n");
  }

  /**
   * Layer 3: What the agent knows about nearby places.
   * For now, uses hardcoded campus data. Module 5 will add Google Places.
   */
    async _getAgentLocalKnowledge(agent) {
    return this.localKnowledge.getContextForPrompt(agent);
  }

  /**
   * Layer 4: What the agent remembers about this user.
   * Simple implementation — Module 4 will make this smarter.
   */
   _getRelevantMemories(agentId, userId, message) {
    return this.memory.getContextForPrompt(agentId, userId, message);
  }

  /**
   * Layer 5: Current moment context.
   */
  _buildCurrentContext(agent, options) {
    const now = new Date();
    const hour = now.getHours();
    const timeStr = now.toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const dayStr = now.toLocaleDateString("en-AU", { weekday: "long" });

    // Determine agent's current time-based state
    const timeState = this._getTimeBehavior(agent, hour);
    if (timeState) {
      agent.state.mood = timeState.mood;
      agent.state.activity = timeState.activity;
    }

    // Proximity
    let proximityNote = "The user is browsing the campus map remotely (FAR).";
    if (options.userLocation) {
      const dist = this._haversineDistance(
        agent.location.lat, agent.location.lng,
        options.userLocation.lat, options.userLocation.lng
      );
      const distRound = Math.round(dist);

      if (dist <= config.campus.proximityZones.intimate) {
        proximityNote = `The user is RIGHT HERE (${distRound}m away). They're at your door. Be personal, warm. Share insider tips.`;
      } else if (dist <= config.campus.proximityZones.nearby) {
        proximityNote = `The user is NEARBY (${distRound}m away). Be warm and share recommendations freely.`;
      } else if (dist <= config.campus.proximityZones.vicinity) {
        proximityNote = `The user is in the VICINITY (${distRound}m away). Friendly but standard.`;
      } else {
        proximityNote = `The user is FAR (${distRound}m away). Like a phone call — friendly but slightly more formal.`;
      }
    }

    return `## CURRENT SITUATION
It's ${timeStr} on ${dayStr}.
Your mood: ${agent.state.mood}.
You're currently: ${agent.state.activity}.
${proximityNote}`;
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

      // Handle overnight ranges (e.g., 22:00-06:00)
      if (startH > endH) {
        if (hour >= startH || hour < endH) return state;
      } else {
        if (hour >= startH && hour < endH) return state;
      }
    }
    return null;
  }


  /**
   * Enhanced place detection: after detecting cached matches,
   * also try to find unmatched place-like names in the response
   * by searching the Google cache more aggressively.
   */
  async _buildPlaceCards(mentionedPlaceIds, responseText, agent) {
    const placeCards = [];
    const textLower = responseText.toLowerCase();

    // 1. Build cards for already-detected places
    for (const placeId of mentionedPlaceIds) {
      const placeData = this.localKnowledge.getPlaceById(placeId, agent);
      if (placeData) {
        placeCards.push(this._formatPlaceCard(placeData));
      }
    }

    // 2. Scan response for capitalized multi-word phrases that look like place names
    //    Pattern: 2-4 capitalized words in a row (e.g., "Laksa King", "Phở Hung")
    const placeNamePattern = /(?:at|from|to|visit|try|hit up|go to|near)\s+([A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+(?:\s+[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+){0,3})/g;
    const possibleNames = [];
    let match;

    while ((match = placeNamePattern.exec(responseText)) !== null) {
      const candidate = match[1].trim();
      // Skip if it's an agent name or a generic word
      const isAgent = this.campusData.agents.some(
        (a) => a.name.includes(candidate) || candidate === a.name.split(" ")[0]
      );
      if (!isAgent && candidate.length > 3) {
        possibleNames.push(candidate);
      }
    }

    // Also catch "Place Name" after common prepositions without the regex above
    const simplePattern = /(?:^|\.\s+)([A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+(?:\s+[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+){1,3})\s+(?:is|does|has|for|on|—|–|-)/g;
    while ((match = simplePattern.exec(responseText)) !== null) {
      const candidate = match[1].trim();
      const isAgent = this.campusData.agents.some(
        (a) => a.name.includes(candidate) || candidate === a.name.split(" ")[0]
      );
      if (!isAgent && candidate.length > 3 && !possibleNames.includes(candidate)) {
        possibleNames.push(candidate);
      }
    }

    // 3. Try to find these candidates in our knowledge
    for (const name of possibleNames) {
      // Skip if we already have a card for this
      if (placeCards.some((c) => c.name.toLowerCase().includes(name.toLowerCase()))) continue;

      const found = this.localKnowledge.findPlaceByName(name, agent);
      if (found) {
        placeCards.push(this._formatPlaceCard(found));
      }
    }

    return placeCards;
  }

  _formatPlaceCard(placeData) {
    return {
      id: placeData.id,
      name: placeData.name,
      type: placeData.type,
      lat: placeData.lat,
      lng: placeData.lng,
      rating: placeData.rating,
      ratingCount: placeData.ratingCount || null,
      address: placeData.address || null,
      description: placeData.description,
      insiderTip: placeData.insiderTip || null,
      photoUrl: placeData.photoUrl || null,
      website: placeData.website || null,
      isOpen: placeData.isOpen ?? null,
      distance: placeData.distance,
      source: placeData.source,
    };
  }



  /**
   * Detect if the response mentions other agents by name.
   */
  _detectAgentMentions(text, selfId) {
    const mentioned = [];
    for (const agent of this.campusData.agents) {
      if (agent.id === selfId) continue;
      // Check for first name or full name
      const firstName = agent.name.split(" ")[0];
      if (text.includes(firstName) || text.includes(agent.name)) {
        mentioned.push(agent.id);
      }
    }
    return mentioned;
  }

   /**
   * Extract a brief context snippet about a mentioned agent from the response.
   * Finds the sentence(s) containing the agent's name.
   */
  _extractMentionContext(responseText, agentName) {
    const firstName = agentName.split(" ")[0];

    // Split into sentences and find ones mentioning the agent
    const sentences = responseText.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    const relevant = sentences.filter(
      (s) => s.includes(firstName) || s.includes(agentName)
    );

    if (relevant.length > 0) {
      // Return first relevant sentence, capped at 120 chars
      const snippet = relevant[0];
      return snippet.length > 120 ? snippet.substring(0, 117) + "..." : snippet;
    }

    return `${firstName} was mentioned in conversation`;
  }

 /**
   * Detect if the response mentions known places.
   * Checks both hardcoded places AND cached Google Places.
   */
   _detectPlaceMentions(text) {
    const mentioned = [];
    const textLower = text.toLowerCase();

    const PLACE_ALIASES = {
      "grafalis": ["grafali's", "grafalis", "grafali"],
      "church-of-secular": ["church of secular", "secular coffee"],
      "sammys": ["sammy's", "sammys"],
      "wholefoods": ["wholefoods", "whole foods"],
      "gyg": ["gyg", "guzman", "guzman y gomez"],
      "halls-cafe": ["halls cafe", "halls café"],
      "library": ["matheson library", "the library"],
      "ltb": ["learning and teaching", "ltb"],
      "monash-sport": ["monash sport"],
      "bus-interchange": ["bus interchange", "bus loop"],
      "rainforest-walk": ["rainforest walk"],
      "alexander-theatre": ["alexander theatre"],
    };

    // Check hardcoded places using aliases
    if (this.placesData?.places) {
      for (const place of this.placesData.places) {
        const aliases = PLACE_ALIASES[place.id] || [];
        const fullName = place.name.toLowerCase();

        if (textLower.includes(fullName) || aliases.some((a) => textLower.includes(a))) {
          if (!mentioned.includes(place.id)) {
            mentioned.push(place.id);
          }
        }
      }
    }

    // Check cached Google Places
     if (this.localKnowledge?._googleCache) {
      for (const cached of this.localKnowledge._googleCache.values()) {
        for (const place of cached.places || []) {
          if (mentioned.includes(place.id)) continue;

          const placeName = place.name.toLowerCase();
          
          // Forward: response contains the place name
          if (textLower.includes(placeName)) {
            mentioned.push(place.id);
            continue;
          }

          // Reverse: place name contains a phrase from the response
          // Split place name into core words, check if they appear together in response
          const coreWords = placeName.split(/\s+/).filter(w => w.length > 3);
          if (coreWords.length >= 2) {
            const allFound = coreWords.every(w => textLower.includes(w));
            if (allFound) {
              mentioned.push(place.id);
              continue;
            }
          }

          // Partial: first two significant words match (e.g., "Laksa King" matches "Laksa King Restaurant")
          const placeWords = placeName.split(/\s+/).filter(w => w.length > 2);
          if (placeWords.length >= 2) {
            const firstTwo = placeWords.slice(0, 2).join(" ");
            if (textLower.includes(firstTwo)) {
              mentioned.push(place.id);
            }
          }
        }
      }
    }

    return mentioned;
  }

  /**
   * Haversine distance between two lat/lng points in meters.
   */
  _haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in meters
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Track prompt caching performance.
   */
  _trackUsage(usage) {
    if (!usage) return;
    this.stats.totalInputTokens += usage.input_tokens || 0;
    this.stats.totalOutputTokens += usage.output_tokens || 0;
    this.stats.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
    this.stats.cacheReadTokens += usage.cache_read_input_tokens || 0;

    if (usage.cache_read_input_tokens > 0) this.stats.cacheHits++;
    else if (usage.cache_creation_input_tokens > 0) this.stats.cacheMisses++;
  }

  /**
   * Get stats for /api/stats endpoint.
   */
  getStats() {
    const s = this.stats;
    const totalCached = s.cacheHits + s.cacheMisses;
    return {
      totalCalls: s.totalCalls,
      totalErrors: s.totalErrors,
      cache: {
        hits: s.cacheHits,
        misses: s.cacheMisses,
        hitRate: totalCached > 0 ? (s.cacheHits / totalCached * 100).toFixed(1) + "%" : "N/A",
        creationTokens: s.cacheCreationTokens,
        readTokens: s.cacheReadTokens,
      },
      tokens: {
        input: s.totalInputTokens,
        output: s.totalOutputTokens,
      },
      estimatedCost: (
        (s.totalInputTokens * 3.0 / 1_000_000) +
        (s.totalOutputTokens * 15.0 / 1_000_000) +
        (s.cacheCreationTokens * 3.75 / 1_000_000) +
        (s.cacheReadTokens * 0.30 / 1_000_000)
      ).toFixed(5),
    };
  }
}