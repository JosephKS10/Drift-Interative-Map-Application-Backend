/**
 * MemoryManager (Module 4)
 *
 * Per-agent, per-user conversation memory.
 *
 * Each agent independently remembers interactions with each user.
 * Memory is used for two things:
 *  1. Injected into the Claude prompt (Layer 4) so agents recall past conversations
 *  2. Tracking user-agent relationship score (friendly, neutral, cold)
 *
 * Storage: In-memory Map. Resets on server restart.
 * This is intentional for the hackathon — judges get fresh experiences,
 * but within a session, agents remember everything.
 *
 * Retrieval strategy:
 *  - Always include last 3 interactions (recency)
 *  - Keyword match current message against past topics (relevance)
 *  - Cap at 5 memories injected per prompt (token budget)
 *  - Compress older entries when count exceeds threshold
 */

import config from "../config/index.js";

export class MemoryManager {
  constructor() {
    // "agentId:userId" → ConversationStore
    this._store = new Map();
  }

  /**
   * Get or create a conversation store for an agent-user pair.
   */
  _getStore(agentId, userId) {
    const key = `${agentId}:${userId}`;
    if (!this._store.has(key)) {
      this._store.set(key, {
        entries: [],
        relationshipScore: 0.0, // -1 (hostile) to +1 (close friend)
        totalExchanges: 0,
        firstInteraction: null,
        lastInteraction: null,
      });
    }
    return this._store.get(key);
  }

  /**
   * Store a memory after a conversation exchange.
   *
   * @param {string} agentId
   * @param {string} userId
   * @param {string} userMessage - what the user said
   * @param {string} agentResponse - what the agent replied
   * @param {string} agentName - for summary phrasing
   */
  store(agentId, userId, userMessage, agentResponse, agentName) {
    const conv = this._getStore(agentId, userId);
    const now = Date.now();

    // Extract meaningful topics
    const topics = this._extractTopics(userMessage, agentResponse);

    // Detect conversation sentiment
    const sentiment = this._detectSentiment(userMessage);

    // Build a summary from the agent's perspective
    const summary = this._buildSummary(userMessage, agentResponse, agentName, topics);

    conv.entries.push({
      timestamp: now,
      summary,
      topics,
      userSentiment: sentiment,
    });

    // Update relationship score
    conv.relationshipScore = Math.max(-1, Math.min(1,
      conv.relationshipScore + sentiment * 0.1
    ));

    conv.totalExchanges++;
    if (!conv.firstInteraction) conv.firstInteraction = now;
    conv.lastInteraction = now;

    // Compress old entries if we're over the limit
    if (conv.entries.length > config.ai.maxMemoriesPerAgent) {
      this._compress(conv);
    }

    return { summary, topics, sentiment, relationshipScore: conv.relationshipScore };
  }

  /**
   * Retrieve relevant memories for prompt injection.
   * Returns formatted string ready for Layer 4 of the prompt.
   *
   * @param {string} agentId
   * @param {string} userId
   * @param {string} currentMessage - the message being responded to (for relevance matching)
   * @returns {string|null} Formatted memory context, or null if no memories
   */
  getContextForPrompt(agentId, userId, currentMessage) {
    const conv = this._getStore(agentId, userId);
    if (conv.entries.length === 0) return null;

    // Select relevant memories
    const relevant = this._selectRelevant(conv.entries, currentMessage);

    // Format for Claude
    let ctx = "## WHAT YOU REMEMBER ABOUT THIS PERSON\n";

    for (const mem of relevant) {
      const ago = this._timeAgo(mem.timestamp);
      ctx += `- ${ago}: ${mem.summary}\n`;
    }

    // Add relationship summary
    const relDesc = this._describeRelationship(conv);
    ctx += `\n${relDesc}\n`;

    return ctx;
  }

  /**
   * Get raw relationship data for an agent-user pair.
   */
  getRelationship(agentId, userId) {
    const conv = this._getStore(agentId, userId);
    return {
      score: conv.relationshipScore,
      totalExchanges: conv.totalExchanges,
      firstInteraction: conv.firstInteraction,
      lastInteraction: conv.lastInteraction,
      level: this._getRelationshipLevel(conv.relationshipScore),
    };
  }

  /**
   * Get all memories an agent has about a user (for the /memories endpoint).
   */
  getMemories(agentId, userId) {
    const conv = this._getStore(agentId, userId);
    return {
      agentId,
      userId,
      entries: conv.entries.map((e) => ({
        summary: e.summary,
        topics: e.topics,
        timestamp: e.timestamp,
        timeAgo: this._timeAgo(e.timestamp),
      })),
      relationship: this.getRelationship(agentId, userId),
    };
  }

  // ─── Internal Methods ─────────────────────────────────────

  /**
   * Select the most relevant memories for the current conversation.
   * Strategy: last 3 (recency) + keyword matches (relevance), deduped, capped at 5.
   */
  _selectRelevant(entries, currentMessage) {
    const maxInject = config.ai.maxMemoriesInjected;

    // Always include the most recent entries
    const last3 = entries.slice(-3);

    // Keyword match: find entries whose topics overlap with current message
    const messageWords = currentMessage
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);

    const keywordMatched = entries.filter((entry) =>
      entry.topics.some((topic) =>
        messageWords.some((word) => topic.includes(word) || word.includes(topic))
      )
    );

    // Deduplicate (by timestamp as unique key) and cap
    const seen = new Set();
    const combined = [];

    for (const entry of [...last3, ...keywordMatched]) {
      if (!seen.has(entry.timestamp)) {
        seen.add(entry.timestamp);
        combined.push(entry);
      }
    }

    // Sort by timestamp descending (most recent first)
    return combined
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxInject);
  }

  /**
   * Extract meaningful topics from the exchange.
   * Filters out stop words and short words, keeps nouns and key phrases.
   */
  _extractTopics(userMessage, agentResponse) {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "shall", "can", "need", "dare", "ought",
      "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "as", "into", "through", "during", "before", "after", "above", "below",
      "between", "out", "off", "over", "under", "again", "further", "then",
      "once", "here", "there", "when", "where", "why", "how", "all", "each",
      "every", "both", "few", "more", "most", "other", "some", "such", "no",
      "not", "only", "own", "same", "so", "than", "too", "very", "just",
      "because", "but", "and", "or", "if", "while", "about", "what", "which",
      "who", "whom", "this", "that", "these", "those", "i", "me", "my",
      "myself", "we", "our", "you", "your", "he", "him", "his", "she", "her",
      "it", "its", "they", "them", "their", "hey", "hi", "hello", "thanks",
      "yeah", "yes", "no", "okay", "sure", "really", "think", "know", "like",
      "want", "get", "got", "make", "go", "going", "come", "tell", "say",
    ]);

    const combined = (userMessage + " " + agentResponse).toLowerCase();
    const words = combined
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    // Count frequency, return top 5 unique topics
    const freq = {};
    for (const w of words) freq[w] = (freq[w] || 0) + 1;

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * Simple sentiment detection from user message.
   * Returns a value from -0.5 to +0.5.
   * Not ML — just keyword heuristics. Good enough for a hackathon.
   */
  _detectSentiment(message) {
    const lower = message.toLowerCase();

    const positive = [
      "thanks", "thank you", "great", "awesome", "love", "amazing",
      "helpful", "appreciate", "nice", "wonderful", "perfect", "brilliant",
      "cheers", "legend", "excellent", "good", "cool", "sweet",
    ];
    const negative = [
      "bad", "terrible", "awful", "hate", "annoying", "useless",
      "worst", "boring", "rude", "disappointed", "angry", "frustrated",
    ];

    let score = 0.05; // slight positive baseline (they're talking to you = interest)

    for (const word of positive) {
      if (lower.includes(word)) score += 0.15;
    }
    for (const word of negative) {
      if (lower.includes(word)) score -= 0.2;
    }

    return Math.max(-0.5, Math.min(0.5, score));
  }

  /**
   * Build a concise summary from the agent's perspective.
   */
  _buildSummary(userMessage, agentResponse, agentName, topics) {
    const firstName = agentName.split(" ")[0];
    const userBrief = userMessage.length > 50
      ? userMessage.substring(0, 47) + "..."
      : userMessage;

    const topicStr = topics.length > 0
      ? topics.slice(0, 3).join(", ")
      : "general chat";

    // Check if agent mentioned any notable things
    const responseLower = agentResponse.toLowerCase();
    let responseNote = "";

    if (responseLower.includes("recommend")) responseNote = `${firstName} gave a recommendation`;
    else if (responseLower.includes("?")) responseNote = `${firstName} asked them a question back`;
    else responseNote = `${firstName} talked about ${topicStr}`;

    return `User said: "${userBrief}". ${responseNote}.`;
  }

  /**
   * Compress old memories when we exceed the limit.
   * Keeps the last 5 intact, compresses everything before that into 3 summary entries.
   */
  _compress(conv) {
    const keepRecent = 5;
    if (conv.entries.length <= keepRecent + 3) return; // not enough to compress

    const old = conv.entries.slice(0, -keepRecent);
    const recent = conv.entries.slice(-keepRecent);

    // Group old entries into chunks and summarize
    const chunkSize = Math.ceil(old.length / 3);
    const compressed = [];

    for (let i = 0; i < old.length; i += chunkSize) {
      const chunk = old.slice(i, i + chunkSize);
      const allTopics = [...new Set(chunk.flatMap((e) => e.topics))].slice(0, 5);
      const firstTime = chunk[0].timestamp;
      const lastTime = chunk[chunk.length - 1].timestamp;

      compressed.push({
        timestamp: firstTime,
        summary: `(Earlier conversations) Discussed: ${allTopics.join(", ") || "various topics"}. ${chunk.length} exchanges between ${this._timeAgo(firstTime)} and ${this._timeAgo(lastTime)}.`,
        topics: allTopics,
        userSentiment: chunk.reduce((s, e) => s + e.userSentiment, 0) / chunk.length,
        compressed: true,
      });
    }

    conv.entries = [...compressed, ...recent];
    console.log(`[Memory] Compressed ${old.length} old entries → ${compressed.length} summaries`);
  }

  /**
   * Describe the relationship in natural language for prompt injection.
   */
  _describeRelationship(conv) {
    const level = this._getRelationshipLevel(conv.relationshipScore);
    const exchanges = conv.totalExchanges;

    const timeKnown = conv.firstInteraction
      ? this._timeAgo(conv.firstInteraction)
      : "just now";

    let desc = `You've spoken with this person ${exchanges} time(s), first ${timeKnown}. `;

    switch (level) {
      case "close":
        desc += "You consider them a friend. Be warm, share personal stories and gossip freely.";
        break;
      case "friendly":
        desc += "You like them. Be open with recommendations and opinions.";
        break;
      case "neutral":
        desc += "You're still getting to know them. Be friendly but not overly personal.";
        break;
      case "cold":
        desc += "Something about past interactions was off. Be polite but keep your distance.";
        break;
    }

    return desc;
  }

  _getRelationshipLevel(score) {
    if (score >= 0.7) return "close";
    if (score >= 0.3) return "friendly";
    if (score >= -0.3) return "neutral";
    return "cold";
  }

  _timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  }

  /**
   * Stats for debugging.
   */
  getStats() {
    let totalEntries = 0;
    let totalPairs = this._store.size;
    for (const conv of this._store.values()) {
      totalEntries += conv.entries.length;
    }
    return { totalPairs, totalEntries };
  }
}