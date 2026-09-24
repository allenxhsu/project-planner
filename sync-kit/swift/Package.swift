// swift-tools-version: 6.0
import PackageDescription

// The Swift half of sync-kit, for the apps that are not web apps. It speaks
// the same wire protocol as `src/`, so a phone and a browser tab converge
// through one server without either end knowing the other exists.
let package = Package(
    name: "SyncKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "SyncKit", targets: ["SyncKit"])
    ],
    targets: [
        .target(name: "SyncKit"),
        .testTarget(name: "SyncKitTests", dependencies: ["SyncKit"]),
    ]
)
