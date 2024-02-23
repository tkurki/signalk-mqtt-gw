/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
 * Copyright 2024 Karl-Erik Gustafsson
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

const id = 'signalk-mqtt-gw'
import { Context, Plugin, ServerAPI, ValuesDelta } from '@signalk/server-api'
import Aedes, { PublishPacket } from 'aedes'
import mqtt, { IPublishPacket, MqttClient } from 'mqtt'
import { Manager } from 'mqtt-jsonl-store'
import { Server, createServer } from 'net'
import { EventEmitter } from 'stream'

type StopHandlers = (() => void)[]
const PUBLISH_PACKET_TMPL = {
  cmd: 'publish',
  qos: 0,
  dup: false,
  retain: false,
}
interface ConPathVal {
  context: string
  path: string
  value: number
}

enum DataType {
  _1 = '1) vessels.self',
  _2 = '2) all deltas',
  _3 = '3) self paths in JSON format',
  _4 = '4) all deltas + JSON',
}

interface PluginConfig {
  /**
   * @title: Start local server
   * @description: Run local server (publish all deltas there in individual topics based on SK path and convert all data published in them by other clients to SK deltas)',
   * @default: false,
   */
  runLocalServer: boolean

  /**
   * @title: 'Local server port',
   * @default: 1883
   */
  port: number

  /**
   * @title Send data for paths listed below to remote server
   * @default false
   */
  sendToRemote: boolean
  /**
   * @title MQTT server Url (starts with mqtt/mqtts)
   * @description MQTT server that the paths listed below should be sent to
   * @default mqtt://somehost
   */
  remoteHost: string

  /**
   * @title MQTT server username
   */
  username: string

  /**
   * @title MQTT server password
   */
  password: string

  /**
   * @title Reject self signed and invalid server certificates
   */
  rejectUnauthorized: boolean

  /**
   * @title Data to send to remote server
   * @description Select the type of data to send to the remote server
   */
  selectedOption: DataType
  paths: {
    /**
     * @title Path
     */
    path: string
    /**
     * @title Minimum interval between updates for this path to be sent to the server
     */
    interval: number
  }[]
}

export default function PluginFactory(
  app: ServerAPI & {
    selfContext: Context
    selfId: string
    signalk: EventEmitter
  },
): Plugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin: any = {
    id,
    name: 'Signal K - MQTT Gateway',
    description: 'Plugin that provides gateway functionality between Signal K and MQTT',
    unsubscribes: [],
  }

  let server: Server
  let aedes: Aedes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ad: any
  let client: MqttClient
  let manager: Manager
  const setStatus = app.setPluginStatus
  let localServerMessage = 'not running'
  let remoteServerMessage = 'not running'

  let onStop: StopHandlers = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin.start = function (options: PluginConfig) {
    app.debug('Aedes MQTT Plugin Started')
    statusUpdate()
    onStop = []

    if (options.runLocalServer) {
      startLocalServer(options, onStop)
      localServerMessage = 'running on port ' + options.port
      statusUpdate()
    }
    if (options.sendToRemote) {
      manager = new Manager(app.getDataDirPath())
      startMqttClient(manager)
    }
    async function startMqttClient(manager: Manager) {
      await manager.open()
      client = mqtt.connect(options.remoteHost, {
        rejectUnauthorized: options.rejectUnauthorized,
        reconnectPeriod: 60000,
        clientId: app.selfId,
        incomingStore: manager.incoming,
        outgoingStore: manager.outgoing,
        username: options.username,
        password: options.password,
      })
      client.on('error', (err) => console.error(err))

      let deltaHandler: ((delta: ValuesDelta) => void) | undefined = undefined
      if (options.selectedOption === '1) vessels.self') {
        deltaHandler = (delta: ValuesDelta) => publishRemoteDelta(delta, client, false)
        remoteServerMessage = 'vessels.self to ' + options.remoteHost
      } else if (options.selectedOption === '2) all deltas') {
        deltaHandler = (delta: ValuesDelta) => publishRemoteDelta(delta, client, true)
        remoteServerMessage = 'all deltas to ' + options.remoteHost
      } else if (options.selectedOption === '3) self paths in JSON format') {
        startSending(options, client, onStop)
        remoteServerMessage = 'JSON to ' + options.remoteHost
      } else if (options.selectedOption === '4) all deltas + JSON') {
        startSending(options, client, onStop)
        deltaHandler = (delta: ValuesDelta) => publishRemoteDelta(delta, client, true)
        remoteServerMessage = 'all deltas and JSON to ' + options.remoteHost
      }

      if (deltaHandler) {
        app.signalk.on('delta', deltaHandler)
      }

      statusUpdate()

      onStop.push(() => {
        client.end()
        stopManager()
        deltaHandler && app.signalk.removeListener('delta', deltaHandler)
      })
    }
  }

  async function stopManager() {
    try {
      await manager.close()
      app.debug('manager closed')
    } catch (error) {
      app.error(`${error} closing manager`)
    }
  }

  plugin.stop = function stop() {
    onStop.forEach((f) => f())
    onStop = []
    if (server) {
      server.close()
      aedes.close()
      if (ad) {
        ad.stop()
      }
    }
    app.debug('Aedes MQTT Plugin Stopped')
  }

  plugin.schema = require('../dist/PluginConfig.json')

  function outputMessages() {
    setImmediate(() => app.reportOutputMessages())
  }

  function statusUpdate() {
    setStatus(`Broker: ${localServerMessage}, Client: ${remoteServerMessage}`)
  }

  function startSending(
    options: { paths: { path: string; interval: number }[] },
    client: mqtt.MqttClient,
    onStop: StopHandlers,
  ) {
    options.paths.forEach((pathInterval) => {
      onStop.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (app as any).streambundle
          .getSelfBus(pathInterval.path)
          .debounceImmediate(pathInterval.interval * 1000)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .onValue((normalizedPathValue: any) => {
            outputMessages()
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
              { qos: 1 },
            )
          }),
      )
    })
  }

  function publishRemoteDelta(delta: ValuesDelta, client: MqttClient, allDelta: boolean) {
    if (allDelta) {
      publishDelta(delta, client)
    } else {
      if (delta.context === app.selfContext) {
        publishDelta(delta, client)
      }
    }
  }

  function publishDelta(delta: ValuesDelta, client: MqttClient) {
    const prefix = (delta.context === app.selfContext ? 'vessels/self' : delta.context?.replace('.', '/')) + '/'
    ;(delta.updates || []).forEach((update) => {
      ;(update.values || []).forEach((pathValue) => {
        client.publish(
          prefix + pathValue.path.replace(/\./g, '/'),
          pathValue.value === null ? 'null' : toText(pathValue.value),
          { qos: 1 },
        )
      })
    })
    outputMessages()
  }

  function startLocalServer(
    options: {
      port?: number
    },
    onStop: StopHandlers,
  ) {
    aedes = new Aedes()
    server = createServer(aedes.handle)
    const port = options.port || 1883

    server.listen(port, function () {
      app.debug(`Aedes MQTT server is up and running on ${port}`)
      onReady()
    })

    app.signalk.on('delta', publishLocalDelta)
    onStop.push(() => {
      app.signalk.removeListener('delta', publishLocalDelta)
    })

    aedes.on('client', function (client) {
      app.debug(`client ${client.id} connected`)
    })

    aedes.on('publish', async function (packet: IPublishPacket, client) {
      app.debug(`Published ${packet.topic} ${packet.payload.toString()}`)
      if (client) {
        const [valid, skData] = extractSkData(packet)
        if (valid) {
          app.handleMessage(id, toDelta(skData, client.id))
        }
      }
    })

    function onReady() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mdns = require('mdns')
        ad = mdns.createAdvertisement(mdns.tcp('mqtt'), options.port)
        ad.start()
        app.debug('MQTT server is advertised on mDNS as mqtt.tcp://<hostname>:' + options.port)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        console.error(e.message)
      }

      onStop.push(() => {
        server.close()
        aedes.close()
        if (ad) {
          ad.stop()
        }
      })
    }
  }

  function publishLocalDelta(delta: ValuesDelta) {
    const prefix = (delta.context === app.selfContext ? 'vessels/self' : delta.context?.replace('.', '/')) + '/'
    ;(delta.updates || []).forEach((update) => {
      ;(update.values || []).forEach((pathValue) => {
        aedes.publish(
          {
            ...PUBLISH_PACKET_TMPL,
            topic: prefix + pathValue.path.replace(/\./g, '/'),
            payload: pathValue.value === null ? 'null' : toText(pathValue.value),
            qos: 0,
            retain: false,
          } as PublishPacket,
          (e) => e && app.error(e.toString()),
        )
      })
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toText(value: any) {
    if (typeof value !== 'undefined') {
      if (typeof value === 'object') {
        return JSON.stringify(value)
      }
      return value.toString()
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function extractSkData(packet: IPublishPacket): any[] {
    const pathParts = packet.topic.split('/')
    if (pathParts.length < 3 || pathParts[0] != 'vessels' || pathParts[1] != 'self') {
      return [false]
    }
    return [
      true,
      {
        context: 'vessels.' + app.selfId,
        path: pathParts.splice(2).join('.'),
        value: packet.payload ? Number(packet.payload.toString()) : null,
      },
    ]
  }

  function toDelta({ context, path, value }: ConPathVal, clientId: string) {
    return {
      context: context,
      updates: [
        {
          $source: 'mqtt.' + clientId.replace(/\//g, '_').replace(/\./g, '_'),
          values: [
            {
              path: path,
              value: value,
            },
          ],
        },
      ],
    }
  }

  return plugin
}
