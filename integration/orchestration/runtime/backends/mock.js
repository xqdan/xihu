'use strict';

// A backend that answers from the call's own schema: the first enum value of every
// required field (in these workflows that is the "carry on" verdict), empty arrays,
// zero, true. It exists so the runtime, the landing gates and the driver can be
// exercised without a model; it says nothing about design quality.
//
// `reply(call)` may return a value to use instead of the schema-derived one, or
// `undefined` to fall through to it. Returning `null` simulates an agent that
// produced nothing.

function fromSchema(schema, key) {
  if (!schema) return 'x';
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties || {})
        .filter(([name]) => (schema.required || []).includes(name))
        .map(([name, sub]) => [name, fromSchema(sub, name)]));
    case 'array':
      return [];
    case 'boolean':
      return true;
    case 'number':
    case 'integer':
      return 0;
    case 'string':
      return 'x';
    default:
      return null;
  }
}

function createMockBackend({reply} = {}) {
  const calls = [];
  return {
    name: 'mock',
    calls,
    async complete(call) {
      calls.push({label: call.label, attempt: call.attempt});
      if (reply) {
        const custom = reply(call);
        if (custom !== undefined) return custom;
      }
      return call.schema ? fromSchema(call.schema, '') : 'x';
    },
  };
}

module.exports = {createMockBackend, fromSchema};
