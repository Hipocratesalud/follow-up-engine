# Protocols

Versioned JSON care protocols loaded through the `ProtocolSource` port.

A protocol is a cadence of expectations tied to a condition (for example, periodic controls for a chronic patient). Each file carries an `id` and a `version`, recorded on every expectation it creates.

Protocols are never enabled for a clinic without clinical team validation.
