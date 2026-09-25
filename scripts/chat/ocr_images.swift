// ocr_images.swift: on-device OCR for screenshot-offers (SCREENSHOT-OFFERS).
//
// Usage:  swift scripts/chat/ocr_images.swift <image> [<image> ...]
//    or:  swiftc -O scripts/chat/ocr_images.swift -o <bin> && <bin> <image> ...
//
// Prints ONE JSON document on stdout:
//   {"engine":"vision","results":[{"path":..., "ok":true, "width":W, "height":H,
//     "lines":[{"text":..., "conf":0.98, "x":0.1, "y":0.2, "w":0.3, "h":0.02}]}, ...]}
// Boxes are normalised to 0..1 with the origin at the TOP-LEFT (Vision's own origin is
// bottom-left; it is flipped here so callers can sort lines top to bottom by `y`).
// An image that cannot be read gets {"ok":false,"error":...}; the run itself never aborts.
//
// PRIVACY: Apple's Vision framework runs on this Mac. Nothing here opens a socket, and
// `usesLanguageCorrection` only uses the on-device language model. The text is written to
// stdout for the calling script, which stores it in the local, gitignored chat DB only.
// HEIC, PNG and JPEG are all decoded by ImageIO (CGImageSource).
import Foundation
import ImageIO
import Vision

struct Line: Encodable { let text: String; let conf: Float; let x: Double; let y: Double; let w: Double; let h: Double }
struct Result: Encodable {
    let path: String; let ok: Bool; let width: Int?; let height: Int?
    let lines: [Line]?; let error: String?
}
struct Output: Encodable { let engine: String; let results: [Result] }

func loadImage(_ path: String) -> (CGImage?, String?) {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return (nil, "unreadable image file") }
    guard CGImageSourceGetCount(src) > 0,
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return (nil, "no image frame") }
    return (img, nil)
}

func ocr(_ path: String) -> Result {
    let (img, err) = loadImage(path)
    guard let cg = img else { return Result(path: path, ok: false, width: nil, height: nil, lines: nil, error: err) }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    req.recognitionLanguages = ["en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do {
        try handler.perform([req])
    } catch {
        return Result(path: path, ok: false, width: cg.width, height: cg.height, lines: nil,
                      error: "vision failed: \(error.localizedDescription)")
    }
    var lines: [Line] = []
    for obs in req.results ?? [] {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        lines.append(Line(text: top.string, conf: top.confidence,
                          x: Double(b.minX), y: Double(1.0 - b.maxY), w: Double(b.width), h: Double(b.height)))
    }
    lines.sort { abs($0.y - $1.y) < 0.004 ? $0.x < $1.x : $0.y < $1.y }
    return Result(path: path, ok: true, width: cg.width, height: cg.height, lines: lines, error: nil)
}

let paths = Array(CommandLine.arguments.dropFirst())
let results = paths.map { p in autoreleasepool { ocr(p) } }
let enc = JSONEncoder()
enc.outputFormatting = [.withoutEscapingSlashes]
let data = try! enc.encode(Output(engine: "vision", results: results))
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
