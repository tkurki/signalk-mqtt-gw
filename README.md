# Signal K - MQTT Gateway

Signal K Node server plugin that functions as a gateway between MQTT and SK server.

## Local MQTT broker/server
- All SK deltas data available from broker/server. The server is advertised via mdns/Bonjour if available
## MQTT Client
- Send user selectable deltas (vessels.self, all deltas, JSON deltas from selectable paths or alldetas and JSON deltas) to remote broker/server

![image](https://github.com/KEGustafsson/signalk-mqtt-gw/assets/3332251/9e37d8f6-b043-4118-a1c7-0c581d01ffd3)

![image](https://github.com/KEGustafsson/signalk-mqtt-gw/assets/3332251/445fdd5e-9277-4bab-ada0-b58bd02242ed)

![image](https://github.com/KEGustafsson/signalk-mqtt-gw/assets/3332251/20b3ad30-1e48-4b4f-962f-5f64f70bd7e8)


If you run a local server you can send data to the server like so:

`mosquitto_pub -h localhost -p 1883 -m 292 -t 'vessels/self/environment/temperature/outside'`

You can check that data is being sent to the local server with `mosquitto_sub`:
```
$ mosquitto_sub -h localhost -p 1884 -t 'vessels/self/navigation/speedOverGround'
3.58
3.59
3.59
```
