// swift-tools-version: 6.0
//
// Project Planner for macOS — a native shell around the web app. The plan, the
// scheduler and every editing rule stay in ../src; the shell itself (documents,
// menu bar, save panels, PDF) is the shared ToolkitShell package in
// ../../shell-kit. This target is the app's configuration, its menu table and
// the Microsoft Project converter, which is Project Planner's alone.

import PackageDescription

let package = Package(
    name: "ProjectPlanner",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ProjectPlanner", targets: ["ProjectPlanner"]),
    ],
    dependencies: [
        .package(name: "shell-kit", path: "../../shell-kit"),
    ],
    targets: [
        .executableTarget(
            name: "ProjectPlanner",
            dependencies: [.product(name: "ToolkitShell", package: "shell-kit")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "ProjectPlannerTests",
            dependencies: ["ProjectPlanner", .product(name: "ToolkitShell", package: "shell-kit")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
