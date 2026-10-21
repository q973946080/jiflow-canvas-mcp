// Test helper: verify JSON Schemas stay within the the documented contract subset.
// Allowed keywords: type/oneOf/properties/required/additionalProperties/items/enum/const
// plus annotations description/title/default/examples.
import assert from 'node:assert/strict';

export const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

export const ALLOWED_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Return list of subset violations (empty array == compliant). */
export function collectSchemaViolations(schema, path = '$') {
  const violations = [];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path}: schema must be a plain object`);
    return violations;
  }
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) violations.push(`${path}: unsupported JSON-Schema keyword "${key}"`);
  }
  if (schema.type !== undefined) {
    if (Array.isArray(schema.type)) {
      for (const t of schema.type) if (!ALLOWED_SCHEMA_TYPES.has(t)) violations.push(`${path}: unsupported type "${t}"`);
    } else if (!ALLOWED_SCHEMA_TYPES.has(schema.type)) {
      violations.push(`${path}: unsupported type "${schema.type}"`);
    }
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) violations.push(`${path}.oneOf: must be a non-empty array`);
    else schema.oneOf.forEach((sub, i) => violations.push(...collectSchemaViolations(sub, `${path}.oneOf[${i}]`)));
  }
  if (schema.properties !== undefined) {
    if (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      violations.push(`${path}.properties: must be an object`);
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        violations.push(...collectSchemaViolations(sub, `${path}.properties.${name}`));
      }
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string')) {
      violations.push(`${path}.required: must be an array of strings`);
    } else if (schema.properties && typeof schema.properties === 'object') {
      for (const name of schema.required) {
        if (!(name in schema.properties)) violations.push(`${path}.required: "${name}" is not declared in properties`);
      }
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties: must be a boolean within the subset`);
  }
  if (schema.type === 'object' && schema.additionalProperties !== false) {
    violations.push(`${path}: every object schema must set additionalProperties:false`);
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) violations.push(`${path}.items: tuple arrays are outside the subset`);
    else violations.push(...collectSchemaViolations(schema.items, `${path}.items`));
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    violations.push(`${path}.enum: must be an array`);
  }
  return violations;
}

export function assertSchemaSubset(schema, label = '$') {
  assert.deepEqual(collectSchemaViolations(schema, label), [], `${label} is outside the the documented contract JSON-Schema subset`);
}

/** Required-property names of an object schema (empty if none). */
export function requiredOf(schema) {
  assert.equal(schema.type, 'object', 'expected object schema');
  return [...(schema.required ?? [])].sort();
}

/** Sorted property names of an object schema. */
export function propertyNames(schema) {
  assert.equal(schema.type, 'object', 'expected object schema');
  return Object.keys(schema.properties ?? {}).sort();
}
