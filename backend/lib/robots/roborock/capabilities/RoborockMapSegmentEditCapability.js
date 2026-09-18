const MapSegmentEditCapability = require("../../../core/capabilities/MapSegmentEditCapability");
const MultiMapCapability = require("../../../core/capabilities/MultiMapCapability");
const RoborockMapParser = require("../RoborockMapParser");

/**
 * @extends MapSegmentEditCapability<import("../RoborockValetudoRobot")>
 */
class RoborockMapSegmentEditCapability extends MapSegmentEditCapability {
    /**
     * @param {import("../../../entities/core/ValetudoMapSegment")} segmentA
     * @param {import("../../../entities/core/ValetudoMapSegment")} segmentB
     * @returns {Promise<void>}
     */
    async joinSegments(segmentA, segmentB) {
        const nativeSegments = await this.resolveNativeSegments([segmentA, segmentB]);

        await this.robot.sendCommand("merge_segment", nativeSegments.map(segment => {
            return parseInt(segment.id);
        }), {timeout: 5000});

        this.robot.pollMap();
    }

    /**
     * @param {import("../../../entities/core/ValetudoMapSegment")} segment
     * @param {object} pA
     * @param {number} pA.x
     * @param {number} pA.y
     * @param {object} pB
     * @param {number} pB.x
     * @param {number} pB.y
     * @returns {Promise<void>}
     */
    async splitSegment(segment, pA, pB) {
        const nativeSegment = (await this.resolveNativeSegments([segment]))[0];
        const flippedSplitLine = [
            parseInt(nativeSegment.id),
            Math.floor(pA.x * 10),
            Math.floor(RoborockMapParser.DIMENSION_MM - pA.y * 10),
            Math.floor(pB.x * 10),
            Math.floor(RoborockMapParser.DIMENSION_MM - pB.y * 10)
        ];

        await this.robot.sendCommand("split_segment", flippedSplitLine, {timeout: 5000});

        this.robot.pollMap();
    }

    /**
     * @param {Array<import("../../../entities/core/ValetudoMapSegment")>} segments
     * @returns {Promise<Array<import("../../../entities/core/ValetudoMapSegment")>>}
     */
    async resolveNativeSegments(segments) {
        const multiMapCapability = this.robot.capabilities?.[MultiMapCapability.TYPE];

        if (multiMapCapability?.resolveSegments) {
            return multiMapCapability.resolveSegments(segments);
        }

        return segments;
    }
}

module.exports = RoborockMapSegmentEditCapability;
