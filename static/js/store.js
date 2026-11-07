// Persistence layer.
//  - Conversations live in IndexedDB (large quota, handles images well).
//    If IndexedDB is unavailable (private mode, blocked storage) we fall back to
//    an in-memory map so the app keeps working for the session.
//  - Small UI preferences live in localStorage under one JSON key.

const DB_NAME = "novachat";
const DB_VERSION = 1;
const STORE = "conversations";
const PREFS_KEY = "novachat:prefs";

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

export class ConversationStore {
  constructor() {
    this.db = null;
    this.memory = new Map();
  }

  get persistent() {
    return this.db !== null;
  }

  async init() {
    try {
      this.db = await openDb();
    } catch (err) {
      console.warn("NovaChat: IndexedDB unavailable, chats will not persist.", err);
      this.db = null;
    }
  }

  async _tx(mode, fn) {
    const tx = this.db.transaction(STORE, mode);
    const result = await requestToPromise(fn(tx.objectStore(STORE)));
    return result;
  }

  async list() {
    if (!this.db) return [...this.memory.values()];
    try {
      return await this._tx("readonly", (s) => s.getAll());
    } catch (err) {
      console.error(err);
      return [...this.memory.values()];
    }
  }

  async put(conversation) {
    // Store a plain structured-clone-safe copy.
    const copy = JSON.parse(JSON.stringify(conversation));
    this.memory.set(copy.id, copy);
    if (!this.db) return;
    try {
      await this._tx("readwrite", (s) => s.put(copy));
    } catch (err) {
      console.error("NovaChat: could not save conversation", err);
      throw err;
    }
  }

  async delete(id) {
    this.memory.delete(id);
    if (!this.db) return;
    await this._tx("readwrite", (s) => s.delete(id));
  }

  async clear() {
    this.memory.clear();
    if (!this.db) return;
    await this._tx("readwrite", (s) => s.clear());
  }
}

// ------------------------------------------------------------------ prefs
const DEFAULT_PREFS = {
  theme: "system", // system | light | dark
  model: null,
  effort: null,
  persona: null,
  showThinking: true,
  customInstructions: "",
  accessCode: "",
  sidebarCollapsed: false,
  lastConversationId: null,
};

function readPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const current = readPrefs();

export const prefs = {
  get(key) {
    return current[key];
  },
  set(key, value) {
    current[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(current));
    } catch {
      /* storage unavailable - keep the value for this session only */
    }
  },
};
