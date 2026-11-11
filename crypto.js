'use strict';
// Password vault. Everything sensitive this device keeps (API keys, settings,
// cached entry titles, unsaved recordings) is encrypted with a key derived from
// the user's password. The key lives only in memory while the app is unlocked.
const Vault = (() => {
  const STORE = 'jr.vault';
  const ITER = 310000;
  const te = new TextEncoder();
  const td = new TextDecoder();
  let key = null;
  let salt = null;

  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const b64url = (u8) => toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64url = (s) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

  async function derive(pw, saltBytes) {
    const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: ITER, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(k, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function open(k, packed) {
    const u8 = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, k, u8.subarray(12)));
  }
  function read() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
  }

  return {
    supported: () => !!(window.crypto && crypto.subtle),
    exists: () => !!read(),
    unlocked: () => !!key,
    async create(pw, data) {
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await derive(pw, salt);
      await this.save(data);
    },
    async unlock(pw) {
      const v = read();
      if (!v) throw new Error('No vault');
      const s = fromB64(v.salt);
      const k = await derive(pw, s);
      let bytes;
      try { bytes = await open(k, fromB64(v.data)); } catch { throw new Error('Wrong password'); }
      key = k; salt = s;
      return JSON.parse(td.decode(bytes));
    },
    async save(data) {
      if (!key) throw new Error('Locked');
      const packed = await seal(key, te.encode(JSON.stringify(data)));
      localStorage.setItem(STORE, JSON.stringify({ v: 1, salt: toB64(salt), data: toB64(packed) }));
    },
    lock() { key = null; salt = null; },
    wipe() { key = null; salt = null; try { localStorage.removeItem(STORE); } catch {} },
    encrypt(bytes) { if (!key) throw new Error('Locked'); return seal(key, bytes); },
    decrypt(bytes) { if (!key) throw new Error('Locked'); return open(key, bytes); },
    async rekey(pw, data) {
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await derive(pw, salt);
      await this.save(data);
    },
    // Setup link payload: salt + sealed JSON, encrypted with the current password.
    async exportLink(data) {
      const packed = await seal(key, te.encode(JSON.stringify(data)));
      const out = new Uint8Array(16 + packed.length);
      out.set(salt); out.set(packed, 16);
      return b64url(out);
    },
    async importLink(pw, payload) {
      const u8 = fromB64url(payload);
      const k = await derive(pw, u8.subarray(0, 16));
      try { return JSON.parse(td.decode(await open(k, u8.subarray(16)))); } catch { throw new Error('Wrong password'); }
    },
  };
})();
