export function bytesPerFrame(channels: number, sampleWidth = 2): number {
    return sampleWidth * channels;
}

export function isAlignedPcmChunk(
    bytes: Uint8Array,
    channels: number,
    sampleWidth = 2,
): boolean {
    const frameBytes = bytesPerFrame(channels, sampleWidth);
    return bytes.byteLength === 0 || bytes.byteLength % frameBytes === 0;
}

export function toUint8Array(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}