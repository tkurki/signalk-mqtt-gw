# Use cases

- Client Use: use Signal K data for display etc via MQTT
- Server Receive: receive data via MQTT for integration in a Signal K server's data flows
- Delta Tunneling: use MQTT as a reliable transport protocol for Signal K delta stream

# Mapping between Signal K Paths and MQTT topics

- map Signal K paths directly to MQTT topics with / as delimiter
- map : character (that has special meaning in MQTT topics) in Signal K entity identifiers somehow
  - if we map it to simply / then you can not easily subscribe to all vessels' position, since mmsi and uuid identities have different structure: `urn:mrn:imo:mmsi:230099999` and `urn:mrn:signalk:uuid:b7590868-1d62-47d9-989c-32321b349fb9`
  - there probably isn't any mechanism for escaping : in MQTT topic names? we can simply map : to some character that does not appear in MMSI and uuid identities, like underscore _
- special shortcut in case the server is a vessel server: `/vessels/self` corresponds to self data, like elsewhere in Signal K

# Values

If we follow the principle of least surprise in MQTT we publish raw values, mostly numbers as strings.

Signal K object valued properties such as position and ocean current need to be mapped somehow (need to review the values in the schema):
- as comma delimited raw values as strings: this can support only one level of values, no hierarchical structures, and we need to specify the order somehow
- as JSON values: verbose and differs from normal values

# Delta Tunneling

- define generic `/deltas` topic to stream any Signal K data
- define entity specific topic `/vessels/<id>/deltas` to stream vessel specific data and use per path access control mechanism to allow different users access to each vessel's delta topic. The use case here is to creata an aggregating service that handles data from multiple vessel sources.
