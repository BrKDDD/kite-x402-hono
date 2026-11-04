import zlib from 'zlib';

export function shouldCompress(contentLength: number, mimeType = 'application/json'): boolean {
  if (contentLength < 1024) return false;
  return /json|text|javascript/.test(mimeType);
}

export function compressGzip(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gzip(buffer, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}
