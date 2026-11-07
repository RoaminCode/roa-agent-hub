'use strict';

// An in-memory stand-in for the few Firestore calls Basecamp makes (doc get and set with
// merge, add, where ==, transactions, batches), for tests. `data` is { collection: { id: doc } }.
function createFakeFirestore(data = {}) {
  let nextId = 1;
  const table = (name) => (data[name] = data[name] || {});
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function write(name, id, value, opts = {}) {
    const t = table(name);
    t[id] = opts.merge ? { ...(t[id] || {}), ...copy(value) } : copy(value);
  }
  function docRef(name, id) {
    return {
      _name: name,
      _id: id,
      get: async () => ({ exists: id in table(name), id, data: () => copy(table(name)[id]) }),
      set: async (value, opts) => write(name, id, value, opts),
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
      const writes = [];
      const result = await fn({ get: (ref) => ref.get(), set: (ref, value, opts) => writes.push([ref, value, opts]) });
      for (const [ref, value, opts] of writes) write(ref._name, ref._id, value, opts);
      return result;
    },
    batch: () => {
      const writes = [];
      return { set: (ref, value, opts) => writes.push([ref, value, opts]), commit: async () => writes.forEach(([ref, v, o]) => write(ref._name, ref._id, v, o)) };
    },
  };
}

module.exports = { createFakeFirestore };
