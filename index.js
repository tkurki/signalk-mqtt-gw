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


const id = "signalk-mqtt-gw"
const debug = require('debug')(id)
const mosca = require('mosca')
const mdns = require('mdns')

module.exports = function(app) {
  var plugin = {
    unsubscribes: []
  };

  plugin.id = id
  plugin.name = "Signal K - MQTT Gateway"
  plugin.description = "plugin that provides gateway functionality between Signal K and MQTT"

  plugin.schema = {
    title: "Signal K - MQTT Gateway",
    type: "object",
    required: ["port"],
    properties: {
      port: {
        type: "number",
        title: "Port",
        default: 1883
      }
    }
  }

  var server
  var started = false
  var ad

  function publishDelta(delta) {
    const prefix = (delta.context === app.selfContext ? 'vessels/self' : delta.context.replace('.', '/')) + '/'
    delta.updates.forEach(update => {
      update.values.forEach(pathValue => {
        server.publish({
          topic: prefix + pathValue.path.replace('.', '/'),
          payload: pathValue.value === null ? "null" : pathValue.value.toString(),
          qos: 0,
          retain: false
        })
      })
    })
  }


  plugin.start = function(options) {
    server = new mosca.Server(options)

    app.signalk.on('delta', publishDelta)


    server.on('clientConnected', function(client) {
      console.log('client connected', client.id);
    });

    server.on('published', function(packet, client) {
      if(client) {
        var skData = extractSkData(packet)
        if(skData.valid) {
          app.signalk.addDelta(toDelta(skData, client))
        }
      }
    });


    server.on('ready', onReady);

    function onReady() {
      ad = mdns.createAdvertisement(mdns.tcp('mqtt'), options.port);
      ad.start();
      console.log('Mosca MQTT server is up and running on port ' + options.port)
    }
    started = true
  }

  plugin.stop = function() {
    if(started) {
      app.signalk.on('delta', publishDelta)
    }
    if(server) {
      server.close()
    }
    if(ad) {
      ad.stop()
    }
    started = false
  };

  return plugin;

  function extractSkData(packet) {
    const result = {
      valid: false
    }
    const pathParts = packet.topic.split('/')
    if(pathParts.length < 3 ||  pathParts[0] != 'vessels' ||  pathParts[1] != 'self')  {
      return result
    }
    result.context = 'vessels.' + app.selfId
    result.path = pathParts.splice(2).join('.')
    if(packet.payload) {
      result.value = Number(packet.payload.toString())
    }
    result.valid = true
    return result;
  }

  function toDelta(skData, client) {
    return {
      context: skData.context,
      updates: [
        {
          '$source': "mqtt." + client.id.replace('/', '_').replace('.', '_'),
          values: [
            {
              path: skData.path,
              value: skData.value
          }
        ]
  }]
    }
  }
}
