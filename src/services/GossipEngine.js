/**
 * GossipEngine + RelationTracker (Module 6)
 *
 * Makes agents aware of each other's conversations.
 *
 * Two systems:
 *  1. GossipEngine — tracks cross-agent mentions and injects them into prompts
 *  2. RelationTracker — manages agent↔agent sentiment (pre-seeded + dynamic)
 *
 * Gossip sources:
 *  - Seeded: loaded from gossip-seeds.json at boot (the 5 storylines)
 *  - Dynamic: created when AgentEngine detects an agent mention in a response
 *
 * Usage flow:
 *  1. User talks to Arjun. Arjun mentions Zoe in his response.
 *  2. AgentEngine calls gossipEngine.recordMention(arjun, zoe, context)
 *  3. User later talks to Zoe.
 *  4. AgentEngine calls gossipEngine.getGossipForPrompt(zoe, userId)
 *  5. Zoe's prompt includes: "Arjun recently told this user about you..."
 *  6. Zoe can now react: "Oh, Arjun said that? He's one to talk."
 */

import config from "../config/index.js";

export class GossipEngine {
  constructor(gossipData, campusData) {
    // Dynamic gossip: agentId → Array<GossipEntry>
    // "What has been said ABOUT this agent"
    this._gossipAbout = new Map();

    // Dynamic gossip: agentId → Array<GossipEntry>
    // "What has this agent SAID about others"
    this._gossipFrom = new Map();

    // Agent-to-agent relationships (pre-seeded from campus data)
    this._agentRelations = new Map();

    // Agent lookup for name resolution
    this._agents = new Map();
    for (const agent of campusData.agents) {
      this._agents.set(agent.id, agent);
      this._gossipAbout.set(agent.id, []);
      this._gossipFrom.set(agent.id, []);
    }

    // Load pre-seeded relationships from campus data
    this._loadRelationships(campusData);

    // Load seeded storyline gossip
    this._loadSeededGossip(gossipData);

    console.log(`[Gossip] Loaded ${this._countSeeded()} seeded gossip entries across ${gossipData.storylines.length} storylines`);
  }

  /**
   * Record that an agent mentioned another agent in conversation.
   * Called by AgentEngine after detecting agent mentions in a response.
   *
   * @param {string} speakerId - agent who said it
   * @param {string} aboutId - agent being talked about
   * @param {string} userId - the user who heard it
   * @param {string} context - what was said (brief)
   */
  recordMention(speakerId, aboutId, userId, context) {
    if (speakerId === aboutId) return; // can't gossip about yourself

    const entry = {
      from: speakerId,
      about: aboutId,
      userId,
      context,
      timestamp: Date.now(),
      source: "dynamic",
    };

    // Store in both directions
    this._gossipAbout.get(aboutId)?.push(entry);
    this._gossipFrom.get(speakerId)?.push(entry);

    const speakerName = this._agents.get(speakerId)?.name || speakerId;
    const aboutName = this._agents.get(aboutId)?.name || aboutId;
    console.log(`[Gossip] ${speakerName} mentioned ${aboutName} to user ${userId}`);

    // Cap gossip per agent at 20 entries
    const aboutList = this._gossipAbout.get(aboutId);
    if (aboutList && aboutList.length > 20) {
      // Remove oldest non-seeded entries
      const dynamic = aboutList.filter((g) => g.source === "dynamic");
      const seeded = aboutList.filter((g) => g.source === "seeded");
      if (dynamic.length > 15) {
        dynamic.splice(0, dynamic.length - 15);
      }
      this._gossipAbout.set(aboutId, [...seeded, ...dynamic]);
    }
  }

  /**
   * Get gossip context for an agent's prompt.
   * Returns what other agents have said ABOUT this agent to this user.
   *
   * @param {string} agentId - the agent who's about to respond
   * @param {string} userId - the user talking to them
   * @returns {string|null} Formatted gossip context for Claude prompt
   */
  getGossipForPrompt(agentId, userId) {
    const gossip = this._gossipAbout.get(agentId) || [];
    if (gossip.length === 0) return null;

    // Filter: only include gossip this specific user has heard
    // (from seeded storylines OR from dynamic mentions to this user)
    const relevant = gossip.filter(
      (g) => g.source === "seeded" || g.userId === userId
    );

    if (relevant.length === 0) return null;

    // Deduplicate by speaker (keep most recent per speaker)
    const bySpaker = new Map();
    for (const g of relevant) {
      const existing = bySpaker.get(g.from);
      if (!existing || g.timestamp > existing.timestamp) {
        bySpaker.set(g.from, g);
      }
    }

    const entries = [...bySpaker.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 4); // max 4 gossip items per prompt

    let ctx = "## WHAT OTHERS HAVE SAID ABOUT YOU (to this user)\n";
    ctx += "React naturally — you might agree, disagree, be amused, or annoyed.\n\n";

    for (const g of entries) {
      const speakerName = this._getFirstName(g.from);
      const ago = this._timeAgo(g.timestamp);
      ctx += `- ${speakerName} (${ago}): ${g.context}\n`;
    }

    return ctx;
  }

  /**
   * Get gossip context for what an agent knows about other agents.
   * Includes seeded storyline gossip — things this agent would know
   * about others even without the user telling them.
   *
   * @param {string} agentId - the agent who's about to respond
   * @returns {string|null}
   */
  getAgentKnowledgeForPrompt(agentId) {
    // Get seeded gossip that this agent is the speaker of
    const fromThis = (this._gossipFrom.get(agentId) || [])
      .filter((g) => g.source === "seeded");

    if (fromThis.length === 0) return null;

    let ctx = "## GOSSIP YOU KNOW (things you've observed or heard)\n";
    ctx += "You can share these naturally if relevant — don't force them.\n\n";

    for (const g of fromThis.slice(0, 4)) {
      const aboutName = this._getFirstName(g.about);
      ctx += `- About ${aboutName}: ${g.context}\n`;
    }

    return ctx;
  }

  /**
   * Get the agent-to-agent relationship context.
   *
   * @param {string} agentId
   * @returns {object} Map of agentId → { sentiment, context }
   */
  getAgentRelationships(agentId) {
    return this._agentRelations.get(agentId) || {};
  }

  /**
   * Record that a user mentioned one agent while talking to another.
   * This is different from an agent mentioning another agent —
   * this is the user saying "Arjun told me X" to Zoe.
   *
   * @param {string} listeningAgentId - who heard it
   * @param {string} mentionedAgentId - who was mentioned
   * @param {string} userId
   * @param {string} whatUserSaid - the user's message
   */
  recordUserMention(listeningAgentId, mentionedAgentId, userId, whatUserSaid) {
    if (listeningAgentId === mentionedAgentId) return;

    const brief = whatUserSaid.length > 80
      ? whatUserSaid.substring(0, 77) + "..."
      : whatUserSaid;

    const mentionedName = this._getFirstName(mentionedAgentId);

    const entry = {
      from: "user",
      about: mentionedAgentId,
      userId,
      context: `The user mentioned ${mentionedName}: "${brief}"`,
      timestamp: Date.now(),
      source: "dynamic",
    };

    // The listening agent now has gossip about the mentioned agent
    // But more importantly, the listening agent knows the user has been
    // talking to the mentioned agent
    this._gossipFrom.get(listeningAgentId)?.push({
      ...entry,
      context: `You learned the user has been talking to ${mentionedName}. They said: "${brief}"`,
    });
  }

  // ─── Internal Methods ──────────────────────────────────

  /**
   * Load pre-seeded relationships from campus agent data.
   */
  _loadRelationships(campusData) {
    for (const agent of campusData.agents) {
      this._agentRelations.set(agent.id, { ...agent.relationships });
    }
  }

  /**
   * Load seeded gossip from gossip-seeds.json storylines.
   */
  _loadSeededGossip(gossipData) {
    if (!gossipData?.storylines) return;

    for (const storyline of gossipData.storylines) {
      for (const gossip of storyline.gossip) {
        // Forward direction: what "from" agent says about "about" agent
        this._gossipFrom.get(gossip.from)?.push({
          from: gossip.from,
          about: gossip.about,
          userId: null, // seeded gossip is available to all users
          context: gossip.text,
          timestamp: Date.now() - 86400000, // pretend it's from yesterday
          source: "seeded",
          storyline: storyline.id,
        });

        // Reverse direction: what the "about" agent knows
        // (they've heard what was said about them)
        this._gossipAbout.get(gossip.about)?.push({
          from: gossip.from,
          about: gossip.about,
          userId: null,
          context: gossip.reverseText,
          timestamp: Date.now() - 86400000,
          source: "seeded",
          storyline: storyline.id,
        });
      }
    }

    // Also load ambient gossip
    if (gossipData.ambientGossip) {
      for (const ambient of gossipData.ambientGossip) {
        this._gossipFrom.get(ambient.from)?.push({
          from: ambient.from,
          about: null,
          userId: null,
          context: ambient.text,
          timestamp: Date.now() - 43200000, // 12 hours ago
          source: "seeded",
        });
      }
    }
  }

  _countSeeded() {
    let count = 0;
    for (const entries of this._gossipAbout.values()) {
      count += entries.filter((g) => g.source === "seeded").length;
    }
    return count;
  }

  _getFirstName(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return agentId;
    return agent.name.split(" ")[0];
  }

  _timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  /**
   * Stats for debugging.
   */
  getStats() {
    let totalDynamic = 0;
    let totalSeeded = 0;
    for (const entries of this._gossipAbout.values()) {
      totalSeeded += entries.filter((g) => g.source === "seeded").length;
      totalDynamic += entries.filter((g) => g.source === "dynamic").length;
    }
    return { seededEntries: totalSeeded, dynamicEntries: totalDynamic };
  }
}