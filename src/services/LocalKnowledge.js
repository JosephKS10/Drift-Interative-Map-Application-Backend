/**
 * LocalKnowledge (Module 5)
 *
 * Provides agents with awareness of nearby places and campus secrets.
 *
 * Two data sources, merged:
 *  1. Hardcoded campus-places.json — always available, insider knowledge
 *  2. Google Places API (optional) — live nearby search, enriches with real data
 *
 * Google results are cached per agent location for 60 minutes.
 * If no Google API key is set, falls back entirely to hardcoded data.
 */

import config from "../config/index.js";

export class LocalKnowledge {
  constructor(placesData) {
    this.placesData = placesData;
    this.googleApiKey = config.google.placesApiKey;
    this.cacheTTL = config.ai.placeCacheMinutes * 60 * 1000;

    // Google Places cache: agentId → { places, fetchedAt }
    this._googleCache = new Map();

    // Pre-index hardcoded places with distance to each potential query point
    this._hardcodedPlaces = placesData?.places || [];
    this._secrets = placesData?.secretKnowledge || [];

    if (this.googleApiKey) {
      console.log("[LocalKnowledge] Google Places API key configured — live enrichment enabled");
    } else {
      console.log("[LocalKnowledge] No Google API key — using hardcoded campus data only");
    }

    console.log(`[LocalKnowledge] ${this._hardcodedPlaces.length} hardcoded places, ${this._secrets.length} secrets loaded`);
  }

  /**
   * Get formatted local knowledge for an agent's prompt (Layer 3).
   *
   * @param {Object} agent - Agent object with location.lat/lng
   * @returns {string|null} Formatted context string for Claude
   */
  async getContextForPrompt(agent) {
    // Get hardcoded places near this agent
    const hardcoded = this._getNearbyHardcoded(agent, 400);

    // Try to get Google Places (cached or fresh)
    let googlePlaces = [];
    if (this.googleApiKey) {
      googlePlaces = await this._getGooglePlaces(agent);
    }

    // Merge: hardcoded takes priority (has insider tips), Google fills gaps
    const merged = this._mergePlaces(hardcoded, googlePlaces, agent);

    if (merged.length === 0 && this._secrets.length === 0) return null;

    // Format for the prompt
    let ctx = "## LOCAL KNOWLEDGE (places near you)\n";

    for (const place of merged.slice(0, 6)) {
      ctx += `- ${place.name} (${place.distance}m away`;
      if (place.rating) ctx += `, ${place.rating}★`;
      ctx += `): ${place.description}`;
      if (place.insiderTip) ctx += ` TIP: ${place.insiderTip}`;
      ctx += "\n";
    }

    // Add 2-3 random campus secrets (different each call for variety)
    if (this._secrets.length > 0) {
      const shuffled = [...this._secrets].sort(() => Math.random() - 0.5);
      ctx += "\nCAMPUS SECRETS (share these naturally, don't list them):\n";
      for (const secret of shuffled.slice(0, 3)) {
        ctx += `- ${secret}\n`;
      }
    }

    return ctx;
  }

  /**
   * Get hardcoded places within a radius of the agent.
   */
  _getNearbyHardcoded(agent, radiusMeters) {
    return this._hardcodedPlaces
      .map((place) => ({
        ...place,
        distance: Math.round(
          this._haversineDistance(
            agent.location.lat, agent.location.lng,
            place.lat, place.lng
          )
        ),
        source: "campus",
      }))
      .filter((p) => p.distance <= radiusMeters)
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Fetch nearby places from Google Places API (New).
   * Cached per agent for cacheTTL milliseconds.
   */
  async _getGooglePlaces(agent) {
    const cacheKey = agent.id;
    const cached = this._googleCache.get(cacheKey);

    // Return cache if still fresh
    if (cached && Date.now() - cached.fetchedAt < this.cacheTTL) {
      return cached.places;
    }

    try {
      const places = await this._fetchGoogleNearby(
        agent.location.lat,
        agent.location.lng,
        500 // 500m radius
      );

      // Cache the results
      this._googleCache.set(cacheKey, {
        places,
        fetchedAt: Date.now(),
      });

      console.log(`[LocalKnowledge] Fetched ${places.length} Google Places for ${agent.name}`);
      return places;
    } catch (error) {
      console.warn(`[LocalKnowledge] Google Places failed for ${agent.name}: ${error.message}`);
      // Return stale cache if available, otherwise empty
      return cached?.places || [];
    }
  }

  /**
   * Call Google Places Nearby Search (New API).
   * Docs: https://developers.google.com/maps/documentation/places/web-service/nearby-search
   */
  async _fetchGoogleNearby(lat, lng, radiusMeters) {
    const url = "https://places.googleapis.com/v1/places:searchNearby";

    const body = {
      includedTypes: ["cafe", "restaurant", "library", "gym", "book_store", "convenience_store"],
      maxResultCount: 10,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusMeters,
        },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.googleApiKey,
        "X-Goog-FieldMask": "places.displayName,places.rating,places.formattedAddress,places.location,places.types,places.userRatingCount",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google API ${response.status}: ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    const places = data.places || [];

    // Transform to our format
    return places.map((p) => ({
      id: `google-${p.displayName?.text?.toLowerCase().replace(/\s+/g, "-") || "unknown"}`,
      name: p.displayName?.text || "Unknown Place",
      type: this._mapGoogleType(p.types),
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      rating: p.rating || null,
      ratingCount: p.userRatingCount || 0,
      description: `${p.displayName?.text} near campus`,
      address: p.formattedAddress || null,
      insiderTip: null, // Google places don't have insider tips
      source: "google",
    }));
  }

  /**
   * Merge hardcoded and Google places.
   * Hardcoded places take priority. Google places fill in gaps.
   * Dedup by name similarity.
   */
  _mergePlaces(hardcoded, google, agent) {
    const merged = [...hardcoded]; // hardcoded first (has insider tips)
    const existingNames = new Set(hardcoded.map((p) => p.name.toLowerCase()));

    for (const gPlace of google) {
      // Skip if we already have a hardcoded version with a similar name
      const nameLower = gPlace.name.toLowerCase();
      const isDuplicate = [...existingNames].some((existing) =>
        existing.includes(nameLower) ||
        nameLower.includes(existing) ||
        this._stringSimilarity(existing, nameLower) > 0.6
      );

      if (!isDuplicate) {
        // Calculate distance from agent
        gPlace.distance = Math.round(
          this._haversineDistance(
            agent.location.lat, agent.location.lng,
            gPlace.lat, gPlace.lng
          )
        );
        merged.push(gPlace);
        existingNames.add(nameLower);
      }
    }

    // Sort by distance
    return merged.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Map Google Places types to our simpler type system.
   */
  _mapGoogleType(types) {
    if (!types) return "other";
    if (types.includes("cafe")) return "cafe";
    if (types.includes("restaurant")) return "restaurant";
    if (types.includes("library")) return "library";
    if (types.includes("gym")) return "gym";
    if (types.includes("book_store")) return "shop";
    return "other";
  }

  /**
   * Simple string similarity (Jaccard on character bigrams).
   */
  _stringSimilarity(a, b) {
    const bigramsA = new Set();
    const bigramsB = new Set();
    for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.substring(i, i + 2));
    for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.substring(i, i + 2));
    const intersection = [...bigramsA].filter((bg) => bigramsB.has(bg)).length;
    const union = new Set([...bigramsA, ...bigramsB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Haversine distance in meters.
   */
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

  /**
   * Stats for debugging.
   */
  getStats() {
    return {
      hardcodedPlaces: this._hardcodedPlaces.length,
      secrets: this._secrets.length,
      googleEnabled: !!this.googleApiKey,
      googleCacheEntries: this._googleCache.size,
    };
  }
}