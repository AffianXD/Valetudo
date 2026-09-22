const Logger = require("../../../Logger");
const MultiMapCapability = require("../../../core/capabilities/MultiMapCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");
const ValetudoMapSegment = require("../../../entities/core/ValetudoMapSegment");

/**
 * @extends MultiMapCapability<import("../RoborockValetudoRobot")>
 */
class RoborockMultiMapCapability extends MultiMapCapability {
    constructor(options) {
        super(options);

        /**
         * The map files exposed by the S5 Max don't contain Valetudo segment
         * metadata. The parsed Valetudo map is therefore the source of truth
         * for this cache. Entries are keyed by the native mapFlag and contain
         * native segment IDs only.
         *
         * @type {Map<string, {segments: Array<{id: string, name?: string, material?: string}>, stale: boolean}>}
         */
        this.mapSegmentCache = new Map();

        /** @type {Map<string, string>} */
        this.mapNames = new Map();

        /** @type {WeakMap<object, string>} */
        this.parsedMapIds = new WeakMap();

        /** @type {string|undefined} */
        this.activeMapId = undefined;

        /** @type {string|undefined} */
        this.pendingMapId = undefined;
    }

    /**
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getMaps() {
        const mapList = await this.getNativeMapList();

        return mapList.map_info.map(mapInfo => {
            const id = String(mapInfo.mapFlag);

            this.mapNames.set(id, typeof mapInfo.name === "string" ? mapInfo.name : "");

            return {
                id: id,
                name: typeof mapInfo.name === "string" ? mapInfo.name : ""
            };
        });
    }

    /**
     * Returns the stable public segment union for all map data known to
     * Valetudo. The active map is captured here as a fallback for startup and
     * normal map polling; subsequent map switches add their parsed map to the
     * same cache.
     *
     * @returns {Promise<Array<import("../../../entities/core/ValetudoMapSegment")>>}
     */
    async getSegments() {
        const maps = await this.getMaps();
        this.updateMapSegmentCache(this.robot.state?.map, undefined, "getSegments");

        const knownMapIds = new Set(maps.map(map => map.id));
        for (const mapId of this.mapSegmentCache.keys()) {
            if (!knownMapIds.has(mapId)) {
                this.mapSegmentCache.delete(mapId);
            }
        }
        const result = [];

        for (const [mapId, entry] of this.mapSegmentCache.entries()) {
            if (!knownMapIds.has(mapId)) {
                continue;
            }

            for (const segment of entry.segments) {
                result.push(new ValetudoMapSegment({
                    id: this.getPublicSegmentId(mapId, segment.id),
                    name: this.getPublicSegmentName(mapId, segment),
                    material: segment.material
                }));
            }
        }

        const sortedResult = result.sort((a, b) => {
            return a.id.localeCompare(b.id, undefined, {numeric: true});
        });

        Logger.debug("[MultiMapSegments] union", {
            activeMapId: this.getActiveMapId(),
            cacheKeys: [...this.mapSegmentCache.keys()],
            publicSegmentIds: sortedResult.map(segment => segment.id)
        });

        return sortedResult;
    }

    /**
     * Store the native segment data from a parsed Valetudo map.
     *
     * @param {import("../../../entities/map/ValetudoMap")} map
     * @param {string=} mapId
     * @param {string=} source
     */
    updateMapSegmentCache(map, mapId, source = "unknown") {
        const resolvedMapId = mapId === undefined ? this.getMapIdFromMap(map) : String(mapId);
        const segmentLayers = Array.isArray(map?.layers) ? map.layers.filter(layer => {
            return layer.type === "segment" && layer.metaData?.segmentId !== undefined;
        }) : [];
        const parsedSegments = typeof map?.getSegments === "function" ? map.getSegments() : [];
        const nativeSegmentIds = parsedSegments.map(segment => {
            const segmentId = String(segment.id);
            const publicPrefix = resolvedMapId === undefined ? undefined : resolvedMapId + ":";

            return publicPrefix && segmentId.startsWith(publicPrefix) ? segmentId.slice(publicPrefix.length) : segmentId;
        });

        Logger.debug("[MultiMapSegments] cache rebuild", {
            source: source,
            activeMapId: this.getActiveMapId(),
            resolvedMapId: resolvedMapId,
            parsedVendorMapId: map?.metaData?.vendorMapId,
            segmentLayerCount: segmentLayers.length,
            nativeSegmentIds: nativeSegmentIds,
            names: parsedSegments.map(segment => segment.name),
            cacheKeysBefore: [...this.mapSegmentCache.keys()]
        });

        if (resolvedMapId === undefined) {
            return;
        }

        const segments = parsedSegments.map(segment => {
            let nativeSegmentId = String(segment.id);
            const publicPrefix = resolvedMapId + ":";

            // This makes the method idempotent if a map has already been
            // decorated for public serialization.
            if (nativeSegmentId.startsWith(publicPrefix)) {
                nativeSegmentId = nativeSegmentId.slice(publicPrefix.length);
            }

            return {
                id: nativeSegmentId,
                name: segment.name,
                material: segment.material
            };
        });

        this.mapSegmentCache.set(resolvedMapId, {
            segments: segments,
            stale: false
        });
        this.parsedMapIds.set(map, resolvedMapId);

        Logger.debug("[MultiMapSegments] cache rebuilt", {
            source: source,
            activeMapId: this.getActiveMapId(),
            parsedVendorMapId: map?.metaData?.vendorMapId,
            cacheKeysAfter: [...this.mapSegmentCache.keys()]
        });
    }

    /**
     * Mark a map's segment cache as requiring a rebuild. The old snapshot is
     * retained for stable publication while the new map is being fetched, but
     * it cannot be used to execute a cleaning action until rebuilt.
     *
     * @param {string} mapId
     */
    invalidateMapSegmentCache(mapId) {
        const entry = this.mapSegmentCache.get(String(mapId));
        if (entry) {
            entry.stale = true;
        }

        Logger.debug("[MultiMapSegments] cache invalidated", {
            mapId: String(mapId),
            cacheKeys: [...this.mapSegmentCache.keys()]
        });
    }

    /**
     * Decorate the currently exposed Valetudo map with stable public segment
     * IDs. Native IDs remain in mapSegmentCache and are restored only when a
     * Roborock command is sent.
     *
     * @param {import("../../../entities/map/ValetudoMap")} map
     * @param {string=} mapId
     */
    decorateMapWithPublicSegmentIds(map, mapId) {
        const resolvedMapId = mapId === undefined ? this.getMapIdFromMap(map) : String(mapId);
        if (resolvedMapId === undefined) {
            return;
        }

        map.layers.forEach(layer => {
            if (layer.type !== "segment" || layer.metaData?.segmentId === undefined) {
                return;
            }

            const nativeSegmentId = String(layer.metaData.segmentId);
            if (!nativeSegmentId.startsWith(resolvedMapId + ":")) {
                layer.metaData.segmentId = this.getPublicSegmentId(resolvedMapId, nativeSegmentId);
            }
        });
    }

    /**
     * Resolve public segment objects to native segment objects after checking
     * map ownership and the active map.
     *
     * @param {Array<import("../../../entities/core/ValetudoMapSegment")>} segments
     * @returns {Promise<Array<import("../../../entities/core/ValetudoMapSegment")>>}
     */
    async resolveSegments(segments) {
        const publicSegments = await this.getSegments();
        const publicSegmentById = new Map(publicSegments.map(segment => {
            return [segment.id, segment];
        }));

        const resolved = [];
        const mapIds = new Set();

        for (const segment of segments) {
            const parsedId = this.parsePublicSegmentId(segment?.id);
            const publicSegmentId = parsedId && this.getPublicSegmentId(parsedId.mapId, parsedId.nativeSegmentId);

            if (!publicSegmentId) {
                throw new Error(`Malformed multi-map segment ID: ${segment?.id}. Expected "<mapId>:<nativeSegmentId>"`);
            }

            const matchingSegment = publicSegmentById.get(publicSegmentId);
            if (!matchingSegment) {
                throw new Error(`Unknown multi-map segment ID: ${segment.id}`);
            }

            const entry = this.mapSegmentCache.get(parsedId.mapId);
            if (!entry || entry.stale) {
                throw new Error(`Segment mapping for map ${parsedId.mapId} is not ready`);
            }

            mapIds.add(parsedId.mapId);
            resolved.push(new ValetudoMapSegment({
                id: parsedId.nativeSegmentId,
                name: matchingSegment.name,
                material: matchingSegment.material,
                metaData: {
                    mapId: parsedId.mapId,
                    nativeSegmentId: parsedId.nativeSegmentId
                }
            }));
        }

        if (mapIds.size > 1) {
            throw new Error("Segments from multiple maps cannot be cleaned together");
        }

        if (mapIds.size === 1) {
            const selectedMapId = [...mapIds][0];
            const activeMapId = this.getActiveMapId();

            if (activeMapId === undefined) {
                throw new Error("Unable to determine the currently active map");
            }
            if (selectedMapId !== activeMapId) {
                throw new Error(`Map ${selectedMapId} is not currently active (active map: ${activeMapId})`);
            }
        }

        return resolved;
    }

    /**
     * Update the active public map ID from Roborock's map_status slot field.
     * The slot is the same identifier used by load_multi_map and is separate
     * from the RRMap header's vendorMapId.
     *
     * @param {number|string} mapId
     */
    updateActiveMapIdFromMapStatus(mapId) {
        const normalizedMapId = String(mapId);

        if (!/^[0-9]+$/.test(normalizedMapId) || normalizedMapId === "63") {
            return;
        }

        if (this.pendingMapId !== undefined && this.pendingMapId !== normalizedMapId) {
            Logger.debug("[MultiMapSegments] ignoring stale map_status while map load is pending", {
                activeMapId: this.activeMapId,
                pendingMapId: this.pendingMapId,
                reportedMapId: normalizedMapId
            });
            return;
        }

        this.activeMapId = normalizedMapId;
        if (this.pendingMapId === normalizedMapId) {
            this.pendingMapId = undefined;
        }

        Logger.debug("[MultiMapSegments] active map updated from map_status", {
            activeMapId: this.activeMapId,
            pendingMapId: this.pendingMapId
        });
    }

    /**
     * @param {string} mapId
     * @param {{id: string, name?: string}} segment
     * @returns {string}
     */
    getPublicSegmentName(mapId, segment) {
        const mapName = this.mapNames.get(mapId)?.trim();
        const segmentName = typeof segment.name === "string" && segment.name.trim() !== "" ? segment.name.trim() : segment.id;

        return `${mapName || `Map ${mapId}`} · ${segmentName}`;
    }

    /**
     * @param {string} mapId
     * @param {string} nativeSegmentId
     * @returns {string}
     */
    getPublicSegmentId(mapId, nativeSegmentId) {
        return `${mapId}:${nativeSegmentId}`;
    }

    /**
     * @param {string} id
     * @returns {{mapId: string, nativeSegmentId: string}|undefined}
     */
    parsePublicSegmentId(id) {
        if (typeof id !== "string") {
            return undefined;
        }

        const match = /^([0-9]+):([0-9]+)$/.exec(id);
        if (!match || match[1] !== String(Number(match[1])) || match[2] !== String(Number(match[2]))) {
            return undefined;
        }

        return {
            mapId: match[1],
            nativeSegmentId: match[2]
        };
    }

    /**
     * @returns {string|undefined}
     */
    getActiveMapId() {
        if (this.activeMapId !== undefined) {
            return this.activeMapId;
        }

        if (this.pendingMapId !== undefined) {
            return this.pendingMapId;
        }

        if (this.robot.mapStatus?.mapSlotId !== undefined) {
            const mapId = String(this.robot.mapStatus.mapSlotId);
            if (mapId !== "63") {
                return mapId;
            }
        }

        return undefined;
    }

    /**
     * @param {import("../../../entities/map/ValetudoMap")} map
     * @returns {string|undefined}
     */
    getMapIdFromMap(map) {
        if (map?.metaData?.vendorMapId === undefined) {
            return undefined;
        }

        const parsedMapId = this.parsedMapIds.get(map);
        if (parsedMapId !== undefined) {
            return parsedMapId;
        }

        if (map !== this.robot.state?.map) {
            return undefined;
        }

        return this.getActiveMapId();
    }

    /**
     * @param {string} id
     * @returns {Promise<void>}
     */
    async loadMap(id) {
        if (typeof id !== "string") {
            throw new Error("Invalid map ID");
        }

        const mapList = await this.getNativeMapList();
        const matchingMap = mapList.map_info.find(mapInfo => {
            return String(mapInfo.mapFlag) === id;
        });

        if (!matchingMap) {
            throw new Error("Unknown map ID: " + id);
        }

        const response = await this.robot.sendCommand("load_multi_map", [Number(matchingMap.mapFlag)], {});

        if (!(Array.isArray(response) && response[0] === "ok")) {
            throw new RobotFirmwareError("Failed to load map: " + response);
        }

        this.pendingMapId = id;
        this.activeMapId = id;
        Logger.debug("[MultiMapSegments] map load accepted", {
            activeMapId: this.activeMapId,
            pendingMapId: this.pendingMapId,
            cacheKeys: [...this.mapSegmentCache.keys()]
        });
        this.invalidateMapSegmentCache(id);
        this.robot.clearValetudoMap();
        await this.robot.pollMap();
    }

    /**
     * @returns {Promise<{map_info: Array<{mapFlag: number, name?: string}>}>}
     */
    async getNativeMapList() {
        const response = await this.robot.sendCommand("get_multi_maps_list", [], {});
        const mapList = Array.isArray(response) ? response[0] : response;

        if (!mapList || !Array.isArray(mapList.map_info)) {
            throw new Error("Received invalid multi-map response: " + JSON.stringify(response));
        }

        return mapList;
    }
}

module.exports = RoborockMultiMapCapability;
