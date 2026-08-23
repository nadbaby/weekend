const NodeCache = require('node-cache');

// Standard TTL of 1 hour, check for expired keys every 2 minutes
const myCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

const cacheService = {
    get: (key) => myCache.get(key),

    set: (key, value, ttl = 3600) => myCache.set(key, value, ttl),

    del: (keys) => myCache.del(keys),

    flush: () => myCache.flushAll(),

    /**
     * Invalidates all product-related caches.
     * Call this when a product is created, updated, or deleted.
     */
    invalidateProductsCache: () => {
        const keys = myCache.keys();
        const productKeys = keys.filter(k =>
            k.startsWith('prod_') ||
            k.startsWith('meta_') ||
            k.startsWith('search_') ||
            k.startsWith('paginated_')
        );
        myCache.del(productKeys);
        console.log(`[CACHE] Invalidated ${productKeys.length} product-related keys.`);
    }
};

module.exports = cacheService;
