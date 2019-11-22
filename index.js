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

const id = 'signalk-mqtt-gw';
const debug = require('debug')(id);
const mosca = require('mosca');
const mqtt = require('mqtt');
const NeDBStore = require('mqtt-nedb-store');

module.exports = function(app) {
  var plugin = {
    unsubscribes: [],
  };
  var server

  plugin.id = id;
  plugin.name = 'Signal K - MQTT Gateway';
  plugin.description =
    'plugin that provides gateway functionality between Signal K and MQTT';

  plugin.schema = {
    title: 'Signal K - MQTT Gateway',
    type: 'object',
    required: ['port'],
    properties: {
      runLocalServer: {
        type: 'boolean',
        title: 'Run local server (publish all deltas there in individual topics based on SK path and convert all data published in them by other clients to SK deltas)',
        default: false,
      },
      port: {
        type: 'number',
        title: 'Local server port',
        default: 1883,
      },
      sendToRemote: {
        type: 'boolean',
        title: 'Send position to remote server',
        default: false,
      },
      remoteHost: {
        type: 'string',
        title: 'MQTT server Url (starts with mqtt/mqtts)',
        description:
          'MQTT server that the paths listed below should be sent to',
        default: 'mqtt://somehost',
      },
      username: {
        type: "string",
        title: "MQTT server username"
      },
      password: {
        type: "string",
        title: "MQTT server password"
      },
      rejectUnauthorized: {
        type: "boolean",
        default: false,
        title: "Reject self signed and invalid server certificates"
      },
      paths: {
        type: 'array',
        title: 'Signal K self paths to send',
        default: [{ path: 'navigation.position', interval: 60 }],
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              title: 'Path',
            },
            interval: {
              type: 'number',
              title:
                'Minimum interval between updates for this path to be sent to the server',
            },
          },
        },
      },
    },
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
      const manager = NeDBStore(app.getDataDirPath());
      const client = mqtt.connect(options.remoteHost, {
        rejectUnauthorized: options.rejectUnauthorized,
        reconnectPeriod: 60000,
        clientId: app.selfId,
        outgoingStore: manager.outgoing,
        username: options.username,
        password: options.password
      });
      client.on('error', (err) => console.error(err))
      startSending(options, client, plugin.onStop);
      plugin.onStop.push(_ => client.end());
    }
    started = true;
  };

  plugin.stop = function() {
    plugin.onStop.forEach(f => f());
  };

  return plugin;

  function startSending(options, client, onStop) {
    options.paths.forEach(pathInterval => {
      onStop.push(
        app.streambundle
          .getSelfBus(pathInterval.path)
          .debounceImmediate(pathInterval.interval * 1000)
          .log()
          .onValue(normalizedPathValue =>
            client.publish(
              'signalk/delta',
              JSON.stringify({
                context: 'vessels.' + app.selfId,
                updates: [
                  {
                    timestamp: normalizedPathValue.timestamp,
                    $source: normalizedPathValue.$source,
                    values: [
                      {
                        path: pathInterval.path,
                        value: normalizedPathValue.value,
                      },
                    ],
                  },
                ],
              }),
              { qos: 1 }
            )
          )
      );
    });
  }

  function startLocalServer(options, onStop) {
    server = new mosca.Server(options);

    app.signalk.on('delta', publishLocalDelta);
    onStop.push(_ => { app.signalk.removeListener('delta', publishLocalDelta) });

    server.on('clientConnected', function(client) {
      console.log('client connected', client.id);
    });

    server.on('published', function(packet, client) {
      if (client) {
        var skData = extractSkData(packet);
        if (skData.valid) {
          app.signalk.addDelta(toDelta(skData, client));
        }
      }
    });

    server.on('ready', onReady);

    function onReady() {
      try {
        const mdns = require('mdns');
        ad = mdns.createAdvertisement(mdns.tcp('mqtt'), options.port);
        ad.start();
      } catch (e) {
        console.error(e.message);
      }
      console.log(
        'Mosca MQTT server is up and running on port ' + options.port
      );
      onStop.push(_ => { server.close() });
    }
  }

  function publishLocalDelta(delta) {
    const prefix =
      (delta.context === app.selfContext
        ? 'vessels/self'
        : delta.context.replace('.', '/')) + '/';
    delta.updates.forEach(update => {
      update.values.forEach(pathValue => {
        server.publish({
          topic: prefix + pathValue.path.replace(/\./g, '/'),
          payload:
            pathValue.value === null ? 'null' : toText(pathValue.value),
          qos: 0,
          retain: false,
        });
      });
    });
  }

  function toText(value) {
    if (typeof value === 'object') {
      return JSON.stringify(value)
    }
    return value.toString()
  }

  function extractSkData(packet) {
    const result = {
      valid: false,
    };
    const pathParts = packet.topic.split('/');
    if (
      pathParts.length < 3 ||
      pathParts[0] != 'vessels' ||
      pathParts[1] != 'self'
    ) {
      return result;
    }
    result.context = 'vessels.' + app.selfId;
    result.path = pathParts.splice(2).join('.');
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
          $source: 'mqtt.' + client.id.replace(/\//g, '_').replace(/\./g, '_'),
          values: [
            {
              path: skData.path,
              value: skData.value,
            },
          ],
        },
      ],
    };
  }
};
