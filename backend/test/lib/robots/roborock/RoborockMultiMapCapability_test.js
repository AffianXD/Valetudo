const assert = require("node:assert");
const {describe, it} = require("node:test");

const RoborockMultiMapCapability = require("../../../../lib/robots/roborock/capabilities/RoborockMultiMapCapability");
const RobotFirmwareError = require("../../../../lib/core/RobotFirmwareError");

const MAP_LIST_RESPONSE = [{
    max_multi_map: 4,
    max_bak_map: 1,
    multi_map_count: 2,
    map_info: [
        {
            mapFlag: 0,
            name: "Ground floor",
            bak_maps: [
                {mapFlag: 4}
            ]
        },
        {
            mapFlag: 1,
            bak_maps: [
                {mapFlag: 5}
            ]
        }
    ]
}];

function createCapability(responses, pollMapImplementation) {
    const calls = [];
    const events = [];
    const robot = {
        clearValetudoMap: function() {
            events.push("clearValetudoMap");
        },
        pollMap: pollMapImplementation ? function() {
            return pollMapImplementation(events);
        } : async function() {
            events.push("pollMap");
        },
        sendCommand: async function(method, args, options) {
            calls.push({method: method, args: args, options: options});

            return responses.shift();
        }
    };

    return {
        capability: new RoborockMultiMapCapability({robot: robot}),
        calls: calls,
        events: events
    };
}

describe("RoborockMultiMapCapability", () => {
    it("normalizes active maps without exposing native metadata", async () => {
        const {capability, calls} = createCapability([MAP_LIST_RESPONSE]);

        const actual = await capability.getMaps();

        assert.deepStrictEqual(actual, [
            {id: "0", name: "Ground floor"},
            {id: "1", name: ""}
        ]);
        assert.deepStrictEqual(calls, [{
            method: "get_multi_maps_list",
            args: [],
            options: {}
        }]);
    });

    it("matches opaque IDs exactly and loads the matched native map", async () => {
        let completePollMap;
        let resolvePollMapStarted;
        let loadResolved = false;
        const pollMapStarted = new Promise(function(resolve) {
            resolvePollMapStarted = resolve;
        });
        const pollMapCompletion = new Promise(function(resolve) {
            completePollMap = resolve;
        });
        const pollMap = function(events) {
            events.push("pollMap");
            resolvePollMapStarted();

            return pollMapCompletion;
        };
        const {capability, calls, events} = createCapability([
            MAP_LIST_RESPONSE,
            ["ok"]
        ], pollMap);

        const loadPromise = capability.loadMap("1").then(function() {
            loadResolved = true;
        });

        await pollMapStarted;

        assert.deepStrictEqual(calls, [
            {
                method: "get_multi_maps_list",
                args: [],
                options: {}
            },
            {
                method: "load_multi_map",
                args: [1],
                options: {}
            }
        ]);
        assert.deepStrictEqual(events, ["clearValetudoMap", "pollMap"]);
        assert.strictEqual(loadResolved, false);

        completePollMap();
        await loadPromise;

        assert.deepStrictEqual(events, ["clearValetudoMap", "pollMap"]);
        assert.strictEqual(loadResolved, true);
    });

    it("rejects unknown and backup-only IDs without loading a map", async () => {
        const {capability, calls} = createCapability([
            MAP_LIST_RESPONSE,
            MAP_LIST_RESPONSE
        ]);

        await assert.rejects(capability.loadMap("01"), /Unknown map ID: 01/);
        await assert.rejects(capability.loadMap("4"), /Unknown map ID: 4/);

        assert.deepStrictEqual(calls.map(call => call.method), [
            "get_multi_maps_list",
            "get_multi_maps_list"
        ]);
    });

    it("does not refresh the cached map when loading fails", async () => {
        const {capability, events} = createCapability([
            MAP_LIST_RESPONSE,
            ["retry"]
        ]);

        await assert.rejects(capability.loadMap("0"), RobotFirmwareError);
        assert.deepStrictEqual(events, []);
    });
});
