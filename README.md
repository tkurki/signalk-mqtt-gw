# Signal K - MQTT Gateway

Signal K Node server plugin that functions as a gateway between MQTT and SK server. You can
- run a local server that has all SK data available and that routes all data from other MQTT clients to Signal K deltas. The server is advertised via mdns/Bonjour
- connect to a MQTT server and send deltas you choose with chosen interval to `signalk/delta`

![image](https://user-images.githubusercontent.com/1049678/28848552-0d624088-771c-11e7-963d-4a7761bfd2a4.png)


If you run a local server you can send data to the server like so:

`mosquitto_pub -h localhost -p 1883 -m 292 -t 'vessels/self/environment/temperature/outside'`
