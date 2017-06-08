/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

const id = "signalk-mqtt-gw";
const debug = require("debug")(id);
const mosca = require("mosca");
const mqtt = require("mqtt");
const mdns = require("mdns");

module.exports = function(app) {
  var plugin = {
    unsubscribes: []
  };

  plugin.id = id;
  plugin.name = "Signal K - MQTT Gateway";
  plugin.description =
    "plugin that provides gateway functionality between Signal K and MQTT";

  plugin.schema = {
    title: "Signal K - MQTT Gateway",
    type: "object",
    required: ["port"],
    properties: {
      runLocalServer: {
        type: "boolean",
        title: "Start local server",
        default: false
      },
      port: {
        type: "number",
        title: "Local server port",
        default: 1883
      },
      sendToRemote: {
        type: "boolean",
        title: "Send to remote server",
        default: false
      },
      remoteHost: {
        type: "string",
        title: "Remote server Url",
        default: "mqtt://somehost"
      }
    }
  };

  var started = false;
  var ad;

  plugin.onStop = [];

  plugin.start = function(options) {
    plugin.onStop = [];

    if (options.runLocalServer) {
      startLocalServer(options, plugin.onStop);
    }
    if (options.sendToRemote) {
      startSending(options, plugin.onStop);
    }
    started = true;
  };

  plugin.stop = function() {
    plugin.onStop.forEach(f => f());
  };

  return plugin;

  function startSending(options, onStop) {
    const client = mqtt.connect(options.remoteHost);

    client.on("connect", function() {
      onStop.push(
        app.streambundle
          .getSelfStream("navigation.position")
          .debounceImmediate(15 * 1000)
          .onValue(value =>
            client.publish(
              "signalk/delta",
              JSON.stringify({
                context: "vessels." + app.selfId,
                updates: [
                  {
                    timestamp: new Date(),
                    values: [
                      {
                        path: "navigation.position",
                        value: value
                      }
                    ]
                  }
                ]
              }),
              {qos: 1}
            )
          )
      );
      onStop.push(_ => client.end());
    });
  }

  function startLocalServer(options, onStop) {
    const server = new mosca.Server(options);

    app.signalk.on("delta", publishLocalDelta);

    server.on("clientConnected", function(client) {
      console.log("client connected", client.id);
    });

    server.on("published", function(packet, client) {
      if (client) {
        var skData = extractSkData(packet);
        if (skData.valid) {
          app.signalk.addDelta(toDelta(skData, client));
        }
      }
    });

    server.on("ready", onReady);

    function onReady() {
      ad = mdns.createAdvertisement(mdns.tcp("mqtt"), options.port);
      ad.start();
      console.log(
        "Mosca MQTT server is up and running on port " + options.port
      );
      onStop.push(_ => {});
    }
  }

  function publishLocalDelta(delta) {
    const prefix =
      (delta.context === app.selfContext
        ? "vessels/self"
        : delta.context.replace(".", "/")) + "/";
    delta.updates.forEach(update => {
      update.values.forEach(pathValue => {
        server.publish({
          topic: prefix + pathValue.path.replace(".", "/"),
          payload: pathValue.value === null
            ? "null"
            : pathValue.value.toString(),
          qos: 0,
          retain: false
        });
      });
    });
  }

  function extractSkData(packet) {
    const result = {
      valid: false
    };
    const pathParts = packet.topic.split("/");
    if (
      pathParts.length < 3 ||
      pathParts[0] != "vessels" ||
      pathParts[1] != "self"
    ) {
      return result;
    }
    result.context = "vessels." + app.selfId;
    result.path = pathParts.splice(2).join(".");
    if (packet.payload) {
      result.value = Number(packet.payload.toString());
    }
    result.valid = true;
    return result;
  }

  function toDelta(skData, client) {
    return {
      context: skData.context,
      updates: [
        {
          $source: "mqtt." + client.id.replace("/", "_").replace(".", "_"),
          values: [
            {
              path: skData.path,
              value: skData.value
            }
          ]
        }
      ]
    };
  }
};
