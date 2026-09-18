const MultiMapCapability = require("../../../core/capabilities/MultiMapCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");

/**
 * @extends MultiMapCapability<import("../RoborockValetudoRobot")>
 */
class RoborockMultiMapCapability extends MultiMapCapability {
    /**
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getMaps() {
        const mapList = await this.getNativeMapList();

        return mapList.map_info.map(mapInfo => {
            return {
                id: String(mapInfo.mapFlag),
                name: typeof mapInfo.name === "string" ? mapInfo.name : ""
            };
        });
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
