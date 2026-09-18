const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/**
 * List and load maps stored by the robot firmware
 *
 * @template {import("../ValetudoRobot")} T
 * @extends Capability<T>
 */
class MultiMapCapability extends Capability {
    /**
     * @abstract
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getMaps() {
        throw new NotImplementedError();
    }

    /**
     * @abstract
     * @param {string} id
     * @returns {Promise<void>}
     */
    async loadMap(id) {
        throw new NotImplementedError();
    }

    getType() {
        return MultiMapCapability.TYPE;
    }
}

MultiMapCapability.TYPE = "MultiMapCapability";

module.exports = MultiMapCapability;
