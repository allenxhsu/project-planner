// swift-tools-version: 6.0
//
// Project Planner for macOS — a native shell around the web app. The model, the
// diagrams and every editing rule stay in ../src; this package supplies what a
// browser tab cannot: documents, the menu bar, save panels and PDF.

import PackageDescription

let package = Package(
    name: "ProjectPlanner",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ProjectPlanner", targets: ["ProjectPlanner"]),
    ],
    targets: [
        // Language mode 5: AppKit's document and WebKit's delegate APIs still
        // carry isolation annotations that Swift 6 mode rejects in practice.
        .executableTarget(
            name: "ProjectPlanner",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "ProjectPlannerTests",
            dependencies: ["ProjectPlanner"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
