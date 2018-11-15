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

const mosca = require('mosca')
const mqtt = require('mqtt')
const NeDBStore = require('mqtt-nedb-store')
const mdns = require('mdns')

const id = 'mqtt-gw'

module.exports = function (app) {
  const plugin = {
    unsubscribes: []
  }
  let server

  plugin.id = id
  plugin.name = 'MQTT'
  plugin.description =
    'plugin that provides gateway functionality between Signal K and MQTT'

  plugin.schema = {
    title: 'Signal K - MQTT Gateway',
    type: 'object',
    required: ['port'],
    properties: {
      runLocalServer: {
        type: 'boolean',
        title: 'Run local server (you must configure a server below to make use of it)',
        default: false
      },
      port: {
        type: 'number',
        title: 'Local server port',
        default: 1883
      },
      mdns: {
        type: 'boolean',
        default: true
      },
      servers: {
        type: 'array',
        title: 'Server Configurations',
        items: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              title: 'MQTT server Url (starts with mqtt/mqtts)',
              default: 'mqtt://somehost'
            },
            username: {
              type: 'string',
              title: 'MQTT server username'
            },
            password: {
              type: 'string',
              title: 'MQTT server password'
            },
            rejectUnauthorized: {
              type: 'boolean',
              default: false,
              title: 'Reject self signed and invalid server certificates'
            },
            publishTopicData: {
              type: 'boolean',
              default: true,
              title: 'Publish subscribed Signal K data in individual topics'
            },
            receiveTopicData: {
              type: 'boolean',
              default: false,
              title: 'Accept data from topics to Signal K input in the server'
            },
            publishDeltaStream: {
              type: 'boolean',
              default: false,
              title: 'Publish subscribed delta stream to /signalk/deltas'
            },
            publishSelfDeltaStream: {
              type: 'boolean',
              default: false,
              title: `Publish subscribed delta stream to /signalk/${app
                .getPath('self')
                .replace(/\:/g, '_')}/deltas`
            },
            receiveDeltaStream: {
              type: 'boolean',
              default: false,
              title: 'Receive delta messages from topic /signalk/deltas'
            },
            receiveSelfDeltaStream: {
              type: 'boolean',
              default: false,
              title: `Receive delta messages from topic /signalk/${app
                .getPath('self')
                .replace(/\:/g, '_')}/deltas`
            },
            subscriptions: {
              type: 'array',
              title: 'Local Signal K subscriptions for data',
              default: [
                JSON.stringify({
                  context: '*',
                  subscribe: [{ path: '*' }]
                })
              ],
              items: {
                type: 'string',
                title: 'Signal K subscription'
              }
            }
          }
        }
      }
    }
  }

  let started = false
  let ad

  plugin.onStop = []

  plugin.start = function (options) {
    plugin.onStop = []

    if (options.runLocalServer) {
      startLocalServer(options, plugin.onStop)
    }
    started = true
  }

  plugin.stop = function () {
    plugin.onStop.forEach(f => f())
  }

  return plugin

  function startLocalServer (options, onStop) {
    server = new mosca.Server(options)

    app.signalk.on('delta', publishLocalDelta)
    onStop.push(_ => {
      app.signalk.removeListener('delta', publishLocalDelta)
    })

    server.on('clientConnected', function (client) {
      app.debug('client connected', client.id)
    })

    server.on('ready', () => {
      if (options.mdns) {
        try {
          ad = mdns.createAdvertisement(mdns.tcp('mqtt'), options.port)
          ad.start()
        } catch (e) {
          console.error(e.message)
        }
      }
      app.debug('Mosca MQTT server is up and running on port ' + options.port)
      onStop.push(_ => {
        server.close()
      })
    })
  }
}
