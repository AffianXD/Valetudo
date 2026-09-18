const MapSegmentationCapability = require("../../../core/capabilities/MapSegmentationCapability");
const MultiMapCapability = require("../../../core/capabilities/MultiMapCapability");

/**
 * @extends MapSegmentationCapability<import("../RoborockValetudoRobot")>
 */
class RoborockMapSegmentationCapability extends MapSegmentationCapability {
    /**
     * @returns {Promise<Array<import("../../../entities/core/ValetudoMapSegment")>>}
     */
    async getSegments() {
        const multiMapCapability = this.robot.capabilities?.[MultiMapCapability.TYPE];

        if (multiMapCapability?.getSegments) {
            return multiMapCapability.getSegments();
        }

        return super.getSegments();
    }

    /**
     * Could be phrased as "cleanSegments" for vacuums or "mowSegments" for lawnmowers
     *
     *
     * @param {Array<import("../../../entities/core/ValetudoMapSegment")>} segments
     * @param {object} [options]
     * @param {number} [options.iterations]
     * @param {boolean} [options.customOrder]
     * @returns {Promise<void>}
     */
    async executeSegmentAction(segments, options) {
        const multiMapCapability = this.robot.capabilities?.[MultiMapCapability.TYPE];
        const nativeSegments = multiMapCapability?.resolveSegments ?
            await multiMapCapability.resolveSegments(segments) :
            segments;

        const segmentIds = nativeSegments.map(segment => {
            return parseInt(segment.id);
        });

        await this.robot.sendCommand("app_segment_clean", [{
            "segments": segmentIds,
            "repeat": options?.iterations ?? 1,
            "clean_order_mode": options?.customOrder === true ? 1 : 0
        }], {});
    }

    /**
     * @returns {import("../../../core/capabilities/MapSegmentationCapability").MapSegmentationCapabilityProperties}
     */
    getProperties() {
        return {
            iterationCount: {
                min: 1,
                max: 3
            },
            customOrderSupport: true
        };
    }
}

module.exports = RoborockMapSegmentationCapability;
