export class LRUCache {
    constructor(limit = 100) {
        this.limit = limit;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        // Refresh item (delete and re-add makes it "most recently used")
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.limit) {
            // Evict oldest (first item in Map)
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        this.cache.delete(key);
    }

    // Helper to get raw map for iteration if absolutely necessary, 
    // though usually not recommended for LRU
    get map() {
        return this.cache;
    }
}