/**
 * Vercel Blob storage adapter for space photographs.
 *
 * Active only when `BLOB_READ_WRITE_TOKEN` is present in the environment.
 * Otherwise the application falls back to the local filesystem (development).
 *
 * The token is read server-side only and is never exposed to the browser.
 */
export function blobEnabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function storeBlob(buffer, sniffedMime) {
  if (!blobEnabled()) return null;
  const { put } = await import('@vercel/blob');
  const ext = sniffedMime === 'image/jpeg' ? 'jpg'
    : sniffedMime === 'image/png' ? 'png'
      : sniffedMime === 'image/webp' ? 'webp' : 'bin';
  const pathname = `spaces/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const result = await put(pathname, buffer, {
    access: 'public',
    contentType: sniffedMime,
    addRandomSuffix: true,
  });
  return {
    storedName: result.pathname.split('/').pop(),
    byteSize: buffer.length,
    mimeType: sniffedMime,
    blobUrl: result.url,
    blobPathname: result.pathname,
  };
}

export async function deleteBlob(pathname) {
  if (!blobEnabled() || !pathname) return false;
  try {
    const { del } = await import('@vercel/blob');
    await del(pathname);
    return true;
  } catch {
    return false;
  }
}
