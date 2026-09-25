// render_fixture.swift: draw SYNTHETIC text lines into a PNG so the OCR test has an image
// that contains no real chat data. Usage: swift render_fixture.swift <out.png> "<line>" ...
// Each argument is one line, drawn top to bottom in black on white. A line of the form
// "L|left text|right text" draws two columns. Test-only; never reads or writes anything else.
import AppKit
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else { FileHandle.standardError.write("usage: out.png line...\n".data(using: .utf8)!); exit(2) }
let out = args[0]
let lines = Array(args.dropFirst())
let width = 1170, lineH = 90, height = max(600, 120 + lines.count * lineH)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 44), .foregroundColor: NSColor.black]
for (i, line) in lines.enumerated() {
    let y = CGFloat(height - 100 - i * lineH)
    if line.hasPrefix("L|") {
        let parts = line.split(separator: "|", omittingEmptySubsequences: false)
        NSString(string: String(parts[1])).draw(at: NSPoint(x: 40, y: y), withAttributes: attrs)
        if parts.count > 2 { NSString(string: String(parts[2])).draw(at: NSPoint(x: 620, y: y), withAttributes: attrs) }
    } else {
        NSString(string: line).draw(at: NSPoint(x: 40, y: y), withAttributes: attrs)
    }
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
