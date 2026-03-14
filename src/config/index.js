import "dotenv/config";

function required(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigin: process.env.CORS_ORIGIN || "*",

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: process.env.AI_MODEL || "claude-sonnet-4-5-20250929",
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || "1024", 10),
  },

  google: {
    placesApiKey: process.env.GOOGLE_PLACES_API_KEY || null, // optional — falls back to hardcoded data
  },

  campus: {
    defaultCampusId: process.env.DEFAULT_CAMPUS || "clayton",
    proximityZones: {
      intimate: 50,    // meters
      nearby: 100,
      vicinity: 300,
    },
  },

  ai: {
    idleThresholdMs: parseInt(process.env.AI_IDLE_THRESHOLD || "3000", 10),
    minIntervalMs: parseInt(process.env.AI_MIN_INTERVAL || "6000", 10),
    confidenceThreshold: parseFloat(process.env.AI_CONFIDENCE_THRESHOLD || "0.5"),
    maxMemoriesPerAgent: parseInt(process.env.MAX_MEMORIES || "20", 10),
    maxMemoriesInjected: 5,    // per prompt
    placeCacheMinutes: 60,     // Google Places cache TTL
  },
};

export default config;
