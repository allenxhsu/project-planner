/**
 * The pairing link a desktop app encodes into a QR code for a phone:
 * `heptabase://connect?url=http://192.168.1.5:7761&token=…`.
 *
 * The scheme is an argument because every app in the suite registers its own —
 * `idef0://`, `pyramid://` — and they all pair the same way. Kept free of any
 * platform import so it can be tested on its own.
 */
export interface ConnectLink {
    url: string;
    token: string;
}
export declare function parseConnectLink(scheme: string, raw: string): ConnectLink | null;
export declare function buildConnectLink(scheme: string, origin: string, token: string): string;
