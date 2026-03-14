// ─── Agent Moods ────────────────────────────────────────────
export const AgentMood = {
  CHEERFUL: "cheerful",
  CONTEMPLATIVE: "contemplative",
  WIRED: "wired",
  GRUMPY: "grumpy",
  PEACEFUL: "peaceful",
  ZOMBIE: "zombie",
  DELIRIOUS: "delirious",
  ENGAGED: "engaged",
  ASLEEP: "asleep",
  MYSTERIOUS: "mysterious",
};

// ─── Proximity Zones ────────────────────────────────────────
export const ProximityZone = {
  INTIMATE: "intimate",   // 0-50m — agent sees you
  NEARBY: "nearby",       // 50-100m — warmer tone
  VICINITY: "vicinity",   // 100-300m — aware of you
  FAR: "far",             // 300m+ — phone-call energy
};

// ─── Socket Events ──────────────────────────────────────────
export const SocketEvents = {
  // Client → Server
  CHAT_START: "chat:start",
  CHAT_MESSAGE: "chat:message",
  CHAT_END: "chat:end",
  USER_MOVE: "user:move",
  USER_WAVE: "agent:wave",

  // Server → Client
  CHAT_RESPONSE: "chat:response",
  CHAT_TYPING: "chat:typing",
  AGENT_UPDATE: "agent:update",
  AGENT_WAVE: "agent:wave:response",
  GOSSIP_NEW: "gossip:new",
  PROXIMITY_ENTER: "proximity:enter",
  PROXIMITY_LEAVE: "proximity:leave",

  // Generic
  ERROR: "error",
};

// ─── Relationship Sentiment Thresholds ──────────────────────
export const SentimentLevel = {
  COLD: -0.3,       // < -0.3: brief, reserved
  NEUTRAL: 0.3,     // -0.3 to 0.3: polite, standard
  FRIENDLY: 0.7,    // 0.3 to 0.7: shares recommendations
  CLOSE: 1.0,       // 0.7 to 1.0: shares gossip, personal stories
};

// ─── Place Types (for Google Places + campus knowledge) ─────
export const PlaceType = {
  CAFE: "cafe",
  RESTAURANT: "restaurant",
  LIBRARY: "library",
  GYM: "gym",
  STUDY_SPACE: "study_space",
  TRANSPORT: "transport",
  SHOP: "shop",
  LANDMARK: "landmark",
  SECRET: "secret",        // insider-only knowledge
};
