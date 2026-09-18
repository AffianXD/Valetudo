const assert = require("node:assert");
const {describe, it} = require("node:test");

const MultiMapCapability = require("../../../../lib/core/capabilities/MultiMapCapability");
const RoborockMapSegmentationCapability = require("../../../../lib/robots/roborock/capabilities/RoborockMapSegmentationCapability");
const RoborockMultiMapCapability = require("../../../../lib/robots/roborock/capabilities/RoborockMultiMapCapability");
const ValetudoMapSegment = require("../../../../lib/entities/core/ValetudoMapSegment");

const MAP_LIST_RESPONSE = [{
    map_info: [
        {mapFlag: 0, name: "EG"},
        {mapFlag: 1, name: "OG"}
    ]
}];

function createMap(mapId, segments) {
    return {
        metaData: {
            vendorMapId: mapId
        },
        getSegments: function() {
            return segments.map(segment => {
                return new ValetudoMapSegment(segment);
            });
        }
    };
}

function createRobot(activeMapId = 0) {
    const calls = [];
    const robot = {
        capabilities: {},
        state: {
            map: createMap(activeMapId, [
                {id: "16", name: activeMapId === 0 ? "Kitchen" : "Bedroom"},
                {id: "17", name: activeMapId === 0 ? "Living room" : "Bathroom"}
            ])
        },
        sendCommand: async function(method, args, options) {
            calls.push({method: method, args: args, options: options});

            if (method === "get_multi_maps_list") {
                return MAP_LIST_RESPONSE;
            }

            return ["ok"];
        }
    };

    const multiMapCapability = new RoborockMultiMapCapability({robot: robot});
    robot.capabilities[MultiMapCapability.TYPE] = multiMapCapability;

    return {
        calls: calls,
        multiMapCapability: multiMapCapability,
        robot: robot,
        segmentationCapability: new RoborockMapSegmentationCapability({robot: robot})
    };
}

function cacheBothMaps(multiMapCapability) {
    multiMapCapability.updateMapSegmentCache(createMap(0, [
        {id: "16", name: "Kitchen"},
        {id: "17", name: "Living room"}
    ]));
    multiMapCapability.updateMapSegmentCache(createMap(1, [
        {id: "16", name: "Bedroom"},
        {id: "17", name: "Bathroom"}
    ]));
}

describe("Roborock multi-map segment identities", () => {
    it("uses distinct public IDs for equal native IDs on different maps", async () => {
        const {multiMapCapability, robot} = createRobot();
        cacheBothMaps(multiMapCapability);

        const segments = await multiMapCapability.getSegments();

        assert.deepStrictEqual(segments.map(segment => segment.id), ["0:16", "0:17", "1:16", "1:17"]);
        assert.strictEqual(segments.find(segment => segment.id === "0:16").name, "EG · Kitchen");
        assert.strictEqual(segments.find(segment => segment.id === "1:16").name, "OG · Bedroom");
        assert.strictEqual(robot.state.map.metaData.vendorMapId, 0);
    });

    it("keeps the public union stable while changing the active map", async () => {
        const {multiMapCapability, robot} = createRobot();
        cacheBothMaps(multiMapCapability);

        const before = (await multiMapCapability.getSegments()).map(segment => segment.id);
        robot.state.map = createMap(1, [
            {id: "16", name: "Bedroom"},
            {id: "17", name: "Bathroom"}
        ]);
        const after = (await multiMapCapability.getSegments()).map(segment => segment.id);

        assert.deepStrictEqual(after, before);
    });

    it("marks a changed map mapping stale until its parsed map rebuilds it", async () => {
        const {multiMapCapability, robot, segmentationCapability} = createRobot();
        cacheBothMaps(multiMapCapability);

        multiMapCapability.invalidateMapSegmentCache("1");
        assert.deepStrictEqual(
            (await multiMapCapability.getSegments()).map(segment => segment.id),
            ["0:16", "0:17", "1:16", "1:17"]
        );

        await assert.rejects(
            segmentationCapability.executeSegmentAction([new ValetudoMapSegment({id: "1:16"})]),
            /mapping for map 1 is not ready/
        );

        robot.state.map = createMap(1, [
            {id: "16", name: "Bedroom"},
            {id: "17", name: "Bathroom"}
        ]);
        multiMapCapability.updateMapSegmentCache(robot.state.map);
        await segmentationCapability.executeSegmentAction([new ValetudoMapSegment({id: "1:16"})]);
    });

    it("cleans active-map segments and preserves multiple selected rooms", async () => {
        const {calls, multiMapCapability, segmentationCapability} = createRobot();
        cacheBothMaps(multiMapCapability);

        await segmentationCapability.executeSegmentAction([
            new ValetudoMapSegment({id: "0:16"}),
            new ValetudoMapSegment({id: "0:17"})
        ], {iterations: 2, customOrder: true});

        assert.deepStrictEqual(calls.at(-1), {
            method: "app_segment_clean",
            args: [{
                segments: [16, 17],
                repeat: 2,
                clean_order_mode: 1
            }],
            options: {}
        });
    });

    it("rejects malformed, unknown, cross-map and inactive-map selections", async () => {
        const {multiMapCapability, robot, segmentationCapability} = createRobot();
        cacheBothMaps(multiMapCapability);

        await assert.rejects(
            segmentationCapability.executeSegmentAction([new ValetudoMapSegment({id: "16"})]),
            /Malformed multi-map segment ID/
        );
        await assert.rejects(
            segmentationCapability.executeSegmentAction([new ValetudoMapSegment({id: "0:99"})]),
            /Unknown multi-map segment ID/
        );
        await assert.rejects(
            segmentationCapability.executeSegmentAction([
                new ValetudoMapSegment({id: "0:16"}),
                new ValetudoMapSegment({id: "1:16"})
            ]),
            /multiple maps/
        );

        robot.state.map = createMap(1, [
            {id: "16", name: "Bedroom"},
            {id: "17", name: "Bathroom"}
        ]);
        await assert.rejects(
            segmentationCapability.executeSegmentAction([new ValetudoMapSegment({id: "0:16"})]),
            /not currently active/
        );
    });

    it("leaves non-MultiMap Roborock cleaning unchanged", async () => {
        const calls = [];
        const robot = {
            capabilities: {},
            sendCommand: async function(method, args, options) {
                calls.push({method: method, args: args, options: options});
                return ["ok"];
            }
        };
        const capability = new RoborockMapSegmentationCapability({robot: robot});

        await capability.executeSegmentAction([new ValetudoMapSegment({id: "16"})]);

        assert.deepStrictEqual(calls, [{
            method: "app_segment_clean",
            args: [{
                segments: [16],
                repeat: 1,
                clean_order_mode: 0
            }],
            options: {}
        }]);
    });
});
