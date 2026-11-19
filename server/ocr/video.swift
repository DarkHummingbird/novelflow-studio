// Extract time-ordered text lines from a locally uploaded video.
import AVFoundation
import CoreGraphics
import Foundation
import Vision

struct ScreenLine: Encodable {
    let text: String
    let y: Double
}

struct Screen: Encodable {
    let at: Double
    let lines: [ScreenLine]
}

func thumbnail(_ image: CGImage) -> [UInt8]? {
    let side = 48
    var bytes = [UInt8](repeating: 0, count: side * side)
    let drawn = bytes.withUnsafeMutableBytes { pixels -> Bool in
        guard let context = CGContext(
            data: pixels.baseAddress, width: side, height: side, bitsPerComponent: 8,
            bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return true
    }
    return drawn ? bytes : nil
}

func sameScreen(_ before: [UInt8]?, _ after: [UInt8]?) -> Bool {
    guard let before, let after else { return false }
    let changed = zip(before, after).filter { abs(Int($0) - Int($1)) > 13 }.count
    return changed < 20
}

func scan(_ asset: AVURLAsset, duration: Double) async -> (frames: [Screen], decoded: Int, recognized: Int) {
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1600, height: 1600)
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.12, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.12, preferredTimescale: 600)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

    var frames: [Screen] = []
    var previous: [UInt8]?
    var decoded = 0
    var recognized = 0
    var times = Array(stride(from: 0.0, to: max(0.01, duration - 0.14), by: 0.5))
    if duration > 0.2 { times.append(duration - 0.1) }
    for seconds in times {
        let time = CMTime(seconds: seconds, preferredTimescale: 600)
        guard let frame = try? await generator.image(at: time) else { continue }
        decoded += 1
        let pixels = thumbnail(frame.image)
        if sameScreen(previous, pixels) { continue }
        let handler = VNImageRequestHandler(cgImage: frame.image, options: [:])
        guard (try? handler.perform([request])) != nil else { continue }
        recognized += 1
        let observations = (request.results ?? []).sorted {
            if abs($0.boundingBox.midY - $1.boundingBox.midY) < 0.007 {
                return $0.boundingBox.minX < $1.boundingBox.minX
            }
            return $0.boundingBox.midY > $1.boundingBox.midY
        }
        let lines = observations.compactMap { item -> ScreenLine? in
            guard let candidate = item.topCandidates(1).first else { return nil }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return ScreenLine(text: text, y: 1 - item.boundingBox.midY)
        }
        if !lines.isEmpty {
            frames.append(Screen(at: seconds, lines: lines))
            previous = pixels
        }
    }
    return (frames, decoded, recognized)
}

guard CommandLine.arguments.count == 2 else { exit(2) }
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
guard let length = try? await asset.load(.duration),
      let tracks = try? await asset.loadTracks(withMediaType: .video),
      !tracks.isEmpty, length.seconds.isFinite, length.seconds > 0 else { exit(3) }
guard length.seconds <= 180.05 else { exit(4) }
let result = await scan(asset, duration: length.seconds)
guard result.decoded > 0 else { exit(3) }
guard result.recognized > 0 else { exit(6) }
guard !result.frames.isEmpty else { exit(5) }
let json = try JSONEncoder().encode(result.frames)
FileHandle.standardOutput.write(json)
