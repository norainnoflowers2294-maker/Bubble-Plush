/**
 * Model storage — "import once, auto-load forever".
 *
 * The .gguf file never comes from a URL. The user picks it from the phone's
 * file system, we copy it into the browser's own persistent sandbox, and from
 * then on the app loads it silently on startup.
 *
 * Primary home:  OPFS (Origin Private File System) — a private, origin-scoped
 *                directory the user never sees in the Files app.
 * Fallback home: IndexedDB blob, for browsers where OPFS writes aren't
 *                available (some iOS Safari versions only expose OPFS to
 *                workers, so `createWritable()` can be missing).
 *
 * Either way, a small metadata record lives in IndexedDB so the UI can show
 * "which model, how big, saved when" without touching the multi-hundred-MB
 * payload.
 */

import { STORAGE } from './config.js';
import { getMeta, setMeta, getModelRecord, setModelRecord, clearModelRecord } from './db.js';

/** True when this browser exposes the OPFS entry point. */
export function supportsOPFS() {
  return Boolean(navigator.storage && navigator.storage.getDirectory);
}

/** Human-readable file size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * Cheap sanity check that we were handed a GGUF file and not, say, a photo.
 * Every GGUF starts with the ASCII magic "GGUF".
 *
 * @param {File} file
 * @returns {Promise<boolean>}
 */
export async function isGguf(file) {
  if (!file || file.size < 8) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x47 && head[1] === 0x47 && head[2] === 0x55 && head[3] === 0x46; // "GGUF"
}

/** @returns {Promise<{name: string, size: number, savedAt: number, mode: 'opfs'|'idb'}|null>} */
export async function getModelMeta() {
  return (await getMeta(STORAGE.keys.modelMeta)) ?? null;
}

/** Ask the browser to keep our storage out of the "clear space" eviction pool. */
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist();
    }
  } catch {
    /* Best effort only — never block an import on this. */
  }
}

/**
 * Copy a picked file into persistent storage.
 *
 * @param {File} file
 * @param {(received: number, total: number) => void} [onProgress]
 * @returns {Promise<{name: string, size: number, savedAt: number, mode: 'opfs'|'idb'}>}
 */
export async function saveModel(file, onProgress) {
  await requestPersistence();

  let mode = 'idb';
  let saved = false;

  if (supportsOPFS()) {
    try {
      await writeToOPFS(file, onProgress);
      mode = 'opfs';
      saved = true;
      // Drop any IndexedDB copy left over from an earlier fallback import —
      // otherwise a whole model's worth of quota stays allocated twice.
      await clearModelRecord().catch(() => {});
    } catch (error) {
      // Most likely `createWritable` is unsupported on this Safari build.
      console.warn('[model-store] OPFS write failed, falling back to IndexedDB:', error);
      await removeOPFSFile().catch(() => {});
    }
  }

  if (!saved) {
    // IndexedDB stores Blobs natively, so this is a straight hand-off.
    await setModelRecord({
      key: 'gguf',
      blob: file,
      name: file.name,
      size: file.size,
      savedAt: Date.now(),
    });
    onProgress?.(file.size, file.size);
  }

  const meta = { name: file.name, size: file.size, savedAt: Date.now(), mode };
  await setMeta(STORAGE.keys.modelMeta, meta);
  return meta;
}

/**
 * Stream the file into OPFS chunk by chunk so a 1 GB model never has to sit in
 * memory as one ArrayBuffer.
 *
 * @param {File} file
 * @param {(received: number, total: number) => void} [onProgress]
 */
async function writeToOPFS(file, onProgress) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(STORAGE.opfsDir, { create: true });
  const handle = await dir.getFileHandle(STORAGE.modelFileName, { create: true });

  if (typeof handle.createWritable !== 'function') {
    throw new Error('OPFS createWritable() is not supported');
  }

  const writable = await handle.createWritable();
  const reader = file.stream().getReader();
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      onProgress?.(received, file.size);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

/** @returns {Promise<File|null>} */
async function readOPFSFile() {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(STORAGE.opfsDir);
    const handle = await dir.getFileHandle(STORAGE.modelFileName);
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function removeOPFSFile() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(STORAGE.opfsDir);
  await dir.removeEntry(STORAGE.modelFileName);
}

/**
 * Fetch the stored model as a Blob, ready to hand to wllama.
 * @returns {Promise<Blob|null>}
 */
export async function readModelBlob() {
  const meta = await getModelMeta();
  if (!meta) return null;

  if (meta.mode === 'opfs') {
    const file = await readOPFSFile();
    if (file) return file;
  }

  const record = await getModelRecord();
  return record?.blob ?? null;
}

/** Delete the model from every place it could live. */
export async function deleteModel() {
  if (supportsOPFS()) {
    await removeOPFSFile().catch(() => {});
  }
  await clearModelRecord().catch(() => {});
  await setMeta(STORAGE.keys.modelMeta, null);
}

/** Storage quota, for the "About" note. */
export async function getStorageEstimate() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
