import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../src/schema.mjs';

test('accepts a matching object and reports nothing', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.deepEqual(validateSchema({ a: 'x' }, schema), []);
});

test('reports type mismatches with the JSON path', () => {
  const errors = validateSchema({ a: 1 }, { type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(errors, ['$.a: expected string, got number']);
});

test('reports missing required keys', () => {
  const errors = validateSchema({}, { type: 'object', required: ['a'] });
  assert.deepEqual(errors, ['$.a: required']);
});

test('rejects unknown keys when additionalProperties is false', () => {
  const errors = validateSchema({ a: 1, b: 2 }, { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false });
  assert.deepEqual(errors, ['$.b: unknown key']);
});

test('validates additionalProperties given as a schema', () => {
  const errors = validateSchema({ x: 1, y: 'no' }, { type: 'object', additionalProperties: { type: 'integer' } });
  assert.deepEqual(errors, ['$.y: expected integer, got string']);
});

test('checks enum, const, pattern, minLength, minimum and maximum', () => {
  assert.deepEqual(validateSchema('c', { enum: ['a', 'b'] }), ['$: must be one of ["a","b"]']);
  assert.deepEqual(validateSchema('0.3', { const: '0.2' }), ['$: must equal "0.2"']);
  assert.deepEqual(validateSchema('ab', { type: 'string', pattern: '^[0-9]+$' }), ['$: does not match /^[0-9]+$/']);
  assert.deepEqual(validateSchema('', { type: 'string', minLength: 1 }), ['$: must have at least 1 characters']);
  assert.deepEqual(validateSchema(0, { type: 'integer', minimum: 1 }), ['$: must be >= 1']);
  assert.deepEqual(validateSchema(9, { type: 'integer', maximum: 5 }), ['$: must be <= 5']);
});

test('validates array items with indexed paths', () => {
  const errors = validateSchema(['a', 2], { type: 'array', items: { type: 'string' } });
  assert.deepEqual(errors, ['$[1]: expected string, got number']);
});

test('accepts a union type and null', () => {
  const schema = { type: ['string', 'null'] };
  assert.deepEqual(validateSchema(null, schema), []);
  assert.deepEqual(validateSchema('x', schema), []);
  assert.deepEqual(validateSchema(1, schema), ['$: expected string or null, got number']);
});
