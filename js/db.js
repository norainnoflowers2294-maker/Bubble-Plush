/**
 * IndexedDB layer — the app's notebook.
 *
 * wllama is stateless: it forgets the conversation the moment the tab reloads.
 * So the *source of truth* for chat history lives here, and every generation
 * rebuilds the prompt from these records (see llm.js).
 *
 * Three stores:
 *   conversations  full conversation objects, keyed by id
 *   meta           small key/value records (settings, model metadata)
 *   model          fallback home for the .gguf blob when OPFS is unavailable
 *                  (older iOS Safari); see model-store.js
 *
 * IndexedDB is callback-based, so every call is wrapped in a promise.
 */

import { STORAGE } from './config.js';

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

/** How long to wait for IndexedDB before calling it unavailable. */
const OPEN_TIMEOUT_MS = 10_000;

/**
 * Open (and migrate) the database exactly once.
 *
 * Rejects instead of hanging when storage is unavailable (private windows,
 * "block all cookies", a corrupt profile) so the app can say what's wrong
 * rather than sit on a blank screen.
 */
export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('This browser has no local storage available.'));
      return;
    }

    const timer = setTimeout(
      () => reject(new Error('Local storage did not respond.')),
      OPEN_TIMEOUT_MS
    );
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };

    const request = indexedDB.open(STORAGE.dbName, STORAGE.dbVersion);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('conversations')) {
        const store = db.createObjectStore('conversations', { keyPath: 'id' });
        // Used to fetch "the most recent conversation" on boot.
        store.createIndex('lastModified', 'lastModified');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('model')) {
        db.createObjectStore('model', { keyPath: 'key' });
      }
    };

    request.onsuccess = settle(() => resolve(request.result));
    request.onerror = settle(() => reject(request.error));
    request.onblocked = settle(() =>
      reject(new Error('Database is blocked by another tab.'))
    );
  });

  return dbPromise;
}

/**
 * Run one request inside a transaction and resolve with its result.
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 */
async function request(storeName, mode, run) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = run(tx.objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  });
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                              */
/* -------------------------------------------------------------------------- */

/** @param {object} conversation */
export function putConversation(conversation) {
  return request('conversations', 'readwrite', (store) => store.put(conversation));
}

/** @param {string} id */
export function getConversation(id) {
  return request('conversations', 'readonly', (store) => store.get(id));
}

/** @param {string} id */
export function deleteConversation(id) {
  return request('conversations', 'readwrite', (store) => store.delete(id));
}

/**
 * The conversation with the highest `lastModified`, i.e. what the user was
 * doing when they last closed the app.
 */
export function getRecentConversation() {
  return request('conversations', 'readonly', (store) => {
    // Walk the index backwards and stop at the first (newest) record.
    return store.index('lastModified').openCursor(null, 'prev');
  }).then((cursor) => (cursor ? cursor.value : null));
}

/** All conversations, newest first. Currently used by Settings/diagnostics. */
export function listConversations() {
  return request('conversations', 'readonly', (store) =>
    store.index('lastModified').getAll()
  ).then((rows) => (rows || []).reverse());
}

/* -------------------------------------------------------------------------- */
/* Meta key/value                                                             */
/* -------------------------------------------------------------------------- */

/** @param {string} key */
export function getMeta(key) {
  return request('meta', 'readonly', (store) => store.get(key)).then((row) =>
    row ? row.value : undefined
  );
}

/**
 * @param {string} key
 * @param {unknown} value
 */
export function setMeta(key, value) {
  return request('meta', 'readwrite', (store) => store.put({ key, value }));
}

/* -------------------------------------------------------------------------- */
/* Model blob fallback (only touched when OPFS is missing)                     */
/* -------------------------------------------------------------------------- */

/** @param {{ key: string, blob: Blob, name: string, size: number, savedAt: number }} record */
export function setModelRecord(record) {
  return request('model', 'readwrite', (store) => store.put(record));
}

export function getModelRecord() {
  return request('model', 'readonly', (store) => store.get('gguf'));
}

export function clearModelRecord() {
  return request('model', 'readwrite', (store) => store.delete('gguf'));
}
