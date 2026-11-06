// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "UncaliveCore",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "UncaliveCore", targets: ["UncaliveCore"])
    ],
    dependencies: [
        .package(url: "https://github.com/scinfu/SwiftSoup.git", from: "2.14.0")
    ],
    targets: [
        .target(name: "UncaliveCore", dependencies: ["SwiftSoup"]),
        .testTarget(
            name: "UncaliveCoreTests",
            dependencies: ["UncaliveCore"],
            resources: [.copy("Fixtures")]
        )
    ]
)
