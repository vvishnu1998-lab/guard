#!/usr/bin/env swift
// Decode the QR code(s) in an image with Apple's Vision framework and print the payload.
//
//   swift scripts/decode-qr.swift code.png [expected-payload]
//
// Exit 0 = decoded (and matched the expected payload, if given); 1 = no code
// found or a mismatch; 2 = usage / unreadable image.
//
// macOS only, a development aid: it proves a QR asset decodes with the same
// engine the iPhone Camera uses. It is NOT a substitute for scanning the
// final asset with a real iPhone Camera and a real Android camera (see the
// QR checklist in the PR). Always run a negative control (gen-store-qr.js
// --noise) so a decoder that "finds" codes in garbage cannot pass this unseen.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2, let image = NSImage(contentsOfFile: args[1]),
      let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else {
    FileHandle.standardError.write("cannot read image\n".data(using: .utf8)!)
    exit(2)
}

let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
    FileHandle.standardError.write("vision error: \(error)\n".data(using: .utf8)!)
    exit(2)
}
let payloads = (request.results ?? []).compactMap { $0.payloadStringValue }
if payloads.isEmpty { print("NO QR FOUND"); exit(1) }
for p in payloads { print("DECODED: \(p)") }
if args.count >= 3 {
    if payloads.contains(args[2]) { print("MATCH"); exit(0) }
    print("MISMATCH (expected \(args[2]))"); exit(1)
}
exit(0)
