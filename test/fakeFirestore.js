'use strict';

// An in-memory stand-in for the few Firestore calls Basecamp makes (doc get, set with merge,
// create, delete, add, where ==, transactions, batches), for tests. `data` is
// { collection: { id: doc } }. Like real Firestore: a merge merges nested maps deeply, create
// fails when the document exists, and a transaction whose documents changed after it read
// them runs again, so two runs racing for the same claim cannot both win.
function createFakeFirestore(data = {}) {
  let nextId = 1;
  const versions = new Map();
  const key = (name, id) => `${name}/${id}`;
  const version = (name, id) => versions.get(key(name, id)) || 0;
  const table = (name) => (data[name] = data[name] || {});
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function deepMerge(into, from) {
    const out = { ...(into || {}) };
    for (const [k, v] of Object.entries(from)) out[k] = isMap(v) && isMap(out[k]) ? deepMerge(out[k], v) : v;
    return out;
  }
  function alreadyExists() {
    const err = new Error('6 ALREADY_EXISTS: Document already exists');
    err.code = 6;
    return err;
  }
  function write(name, id, value, opts = {}) {
    const t = table(name);
    t[id] = opts.merge ? deepMerge(t[id], copy(value)) : copy(value);
    versions.set(key(name, id), version(name, id) + 1);
  }
  function create(name, id, value) {
    if (id in table(name)) throw alreadyExists();
    write(name, id, value);
  }
  function remove(name, id) {
    delete table(name)[id];
    versions.set(key(name, id), version(name, id) + 1);
  }
  const snapshot = (name, id) => ({ exists: id in table(name), id, data: () => copy(table(name)[id]) });
  function docRef(name, id) {
    return {
      _name: name,
      _id: id,
      id,
      get: async () => snapshot(name, id),
      set: async (value, opts) => write(name, id, value, opts),
      create: async (value) => create(name, id, value),
      delete: async () => remove(name, id),
    };
  }
  function collection(name) {
    return {
      doc: (id) => docRef(name, id),
      add: async (value) => {
        const id = `auto${nextId++}`;
        write(name, id, value);
        return docRef(name, id);
      },
      where: (field, op, value) => {
        if (op !== '==') throw new Error(`fake supports == only, not ${op}`);
        return {
          get: async () => ({
            docs: Object.entries(table(name))
              .filter(([, d]) => d[field] === value)
              .map(([id, d]) => ({ id, data: () => copy(d) })),
          }),
        };
      },
    };
  }
  return {
    data,
    collection,
    runTransaction: async (fn) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const read = new Map();
        const writes = [];
        const tx = {
          get: async (ref) => {
            read.set(key(ref._name, ref._id), version(ref._name, ref._id));
            // Yield, as a real read does, so racing transactions interleave.
            await new Promise((resolve) => setImmediate(resolve));
            return snapshot(ref._name, ref._id);
          },
          set: (ref, value, opts) => writes.push(['set', ref, value, opts]),
          create: (ref, value) => writes.push(['create', ref, value]),
          delete: (ref) => writes.push(['delete', ref]),
        };
        const result = await fn(tx);
        const changed = [...read].some(([k, v]) => (versions.get(k) || 0) !== v);
        if (changed) continue;
        for (const [op, ref, value, opts] of writes) {
          if (op === 'set') write(ref._name, ref._id, value, opts);
          else if (op === 'create') create(ref._name, ref._id, value);
          else remove(ref._name, ref._id);
        }
        return result;
      }
      throw new Error('10 ABORTED: too much contention on these documents');
    },
    batch: () => {
      const writes = [];
      return { set: (ref, value, opts) => writes.push([ref, value, opts]), commit: async () => writes.forEach(([ref, v, o]) => write(ref._name, ref._id, v, o)) };
    },
  };
}

module.exports = { createFakeFirestore };
