'use strict';

// A small JSON Schema validator and a tolerant JSON extractor.
//
// Why this exists: the workflow scripts hand `agent()` a JSON Schema and expect the
// reply to conform. Claude Code's Workflow runtime enforces that natively; the
// Cursor SDK has no schema parameter, and a CLI backend can still return text that
// does not parse. The runtime therefore validates every reply itself, whichever
// backend produced it, and retries with the error list when it does not conform.
//
// The repository has no third-party dependencies, so this covers exactly the
// keywords the 21 workflows use (type, properties, required, enum, items,
// additionalProperties, pattern) plus the usual neighbours (const, min/max,
// minItems/maxItems, minProperties/maxProperties, oneOf/anyOf). A keyword it does not
// know is ignored, never treated as a pass-through for the whole schema: unknown
// *types* are errors.

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  if (!TYPES.includes(type)) throw new Error(`schema uses unsupported type "${type}"`);
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateAt(schema, value, at, errors) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    errors.push(`${at}: no value is allowed here`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: does not match /${schema.pattern}/`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: longer than ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined) {
      value.forEach((item, i) => validateAt(schema.items, item, `${at}[${i}]`, errors));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    const names = Object.keys(value);
    if (schema.minProperties !== undefined && names.length < schema.minProperties) {
      errors.push(`${at}: fewer than ${schema.minProperties} propert${schema.minProperties === 1 ? 'y' : 'ies'}`);
    }
    if (schema.maxProperties !== undefined && names.length > schema.maxProperties) {
      errors.push(`${at}: more than ${schema.maxProperties} properties`);
    }
    for (const name of schema.required || []) {
      if (!Object.hasOwn(value, name)) errors.push(`${at}: missing required property "${name}"`);
    }
    for (const [name, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) validateAt(sub, value[name], `${at}.${name}`, errors);
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const name of Object.keys(value)) {
        if (Object.hasOwn(properties, name)) continue;
        if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${name}"`);
        else validateAt(schema.additionalProperties, value[name], `${at}.${name}`, errors);
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s) => {
      const sub = [];
      validateAt(s, value, at, sub);
      return sub.length === 0;
    });
    if (!ok) errors.push(`${at}: matches none of anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((s) => {
      const sub = [];
      validateAt(s, value, at, sub);
      return sub.length === 0;
    }).length;
    if (matched !== 1) errors.push(`${at}: must match exactly one of oneOf (matched ${matched})`);
  }
}

// Returns the list of violations; empty means the value conforms.
function validate(schema, value) {
  const errors = [];
  validateAt(schema, value, '$', errors);
  return errors;
}

// Models wrap JSON in prose or code fences. Accept a bare JSON document, a fenced
// block, or the outermost balanced {...} / [...] in the text. Anything else is a
// parse failure the caller turns into a retry; this never guesses at repairs.
function extractJson(text) {
  if (typeof text !== 'string') throw new Error('reply is not text');
  const trimmed = text.trim();
  const attempts = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());
  const open = trimmed.search(/[[{]/);
  if (open >= 0) {
    const closer = trimmed[open] === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(closer);
    if (end > open) attempts.push(trimmed.slice(open, end + 1));
  }
  let lastError;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`reply is not valid JSON: ${lastError.message}`);
}

// The prompt suffix for backends that cannot take a schema as a parameter: the reply
// is asked to be one bare JSON document, and the runtime validates it.
function withSchema(prompt, schema) {
  if (!schema) return prompt;
  return `${prompt}\n\n你的整个回复必须是一个 JSON 文档（不要 markdown 围栏，不要任何说明文字），并且符合下面的 JSON Schema：\n${JSON.stringify(schema)}`;
}

module.exports = {withSchema, validate, extractJson};
