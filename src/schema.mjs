// Minimal JSON Schema subset validator with no dependencies. It supports the
// keywords brain-kit's own schemas use and nothing else: type (string or
// array), properties, required, additionalProperties (boolean or schema),
// enum, const, items, minimum, exclusiveMinimum (a number, as in the draft
// the schemas declare), maximum, minLength, pattern. A keyword it does not
// know is ignored, so a schema must never rely on one missing here.
// Returns an array of "path: message" strings; an empty array means valid.
export function validateSchema(value, schema, path = '$') {
  const errors = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${describe(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((candidate) => sameJson(candidate, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && !sameJson(schema.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: must be > ${schema.exclusiveMinimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must have at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match /${schema.pattern}/`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(value)) {
      if (key in properties) {
        errors.push(...validateSchema(sub, properties[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unknown key`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validateSchema(sub, schema.additionalProperties, `${path}.${key}`));
      }
    }
  }
  return errors;
}

function matchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    default: return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
