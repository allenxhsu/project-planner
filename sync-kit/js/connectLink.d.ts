/**
 * The pairing link a desktop app encodes into a QR code for a phone:
 * `heptabase://connect?url=http://192.168.1.5:7761&token=…`.
 *
 * The scheme is an argument because every app in the suite registers its own —
 * `idef0://`, `pyramid://` — and they all pair the same way. Kept free of any
 * platform import so it can be tested on its own.
 *
 * Unchanged by the Portal, and used by it. The Portal's Devices page is now
 * the other thing that builds one of these: it mints the token at
 * `POST /auth/devices`, builds `<scheme>://connect?url=&token=` exactly as
 * below, and hands it to the app — as a link the system opens when a native
 * app started the pairing through `/devices/pair?scheme=<scheme>`, or as a QR
 * code for a phone that did not. A desktop app pairing a phone over the LAN
 * still builds the same link for the same camera.
 *
 * One link format, three ways of arriving. `swift/Sources/SyncKit/Pairing.swift`
 * parses it by the same rules, including the refusal of anything that is not
 * an http(s) origin — this string becomes the address every record and every
 * image is fetched from, and `javascript:` has no business being it.
 */
export interface ConnectLink {
    url: string;
    token: string;
}
export declare function parseConnectLink(scheme: string, raw: string): ConnectLink | null;
export declare function buildConnectLink(scheme: string, origin: string, token: string): string;
