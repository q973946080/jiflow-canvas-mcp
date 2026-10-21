/**
 * Minimal JSON-Schema-subset validator used for MCP tool argument validation.
 *
 * Supported keywords: `type`, `oneOf`, `properties`, `required`, `additionalProperties`,
 * `items`, `enum`, `const` plus the annotations `description`, `title`, `default`, `examples`.
 * Values are validated without coercion and narrowed to the declared properties.
 */

const SUPPORTED_KEYWORDS = new Set([
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
  'examples'
]);

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key])
    );
  }
  return false;
}

function matchesType(type, value) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/**
 * Validate that a schema only uses supported keywords (recursively).
 *
 * @param {unknown} schema
 * @param {string} [path]
 */
export function assertSchemaSubset(schema, path = '$') {
  if (!isPlainObject(schema)) {
    throw new TypeError(`schema at ${path} must be a plain object`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new TypeError(`schema at ${path} uses unsupported keyword "${key}"`);
    }
  }
  if (schema.oneOf !== undefined) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new TypeError(`schema at ${path}.oneOf must be a non-empty array`);
    }
    schema.oneOf.forEach((branch, index) => assertSchemaSubset(branch, `${path}.oneOf[${index}]`));
  }
  if (schema.items !== undefined) {
    assertSchemaSubset(schema.items, `${path}.items`);
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      throw new TypeError(`schema at ${path}.properties must be an object`);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSchemaSubset(child, `${path}.properties.${key}`);
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean' &&
    !isPlainObject(schema.additionalProperties)
  ) {
    throw new TypeError(`schema at ${path}.additionalProperties must be boolean or a schema`);
  }
  if (isPlainObject(schema.additionalProperties)) {
    assertSchemaSubset(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === 'string')) {
      throw new TypeError(`schema at ${path}.required must be an array of strings`);
    }
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    throw new TypeError(`schema at ${path}.enum must be an array`);
  }
  return true;
}

function validateNode(schema, value, path, errors) {
  const branchResults = [];
  if (schema.oneOf !== undefined) {
    schema.oneOf.forEach((branch, index) => {
      const branchErrors = [];
      const narrowed = validateNode(branch, value, path, branchErrors);
      if (branchErrors.length === 0) {
        branchResults.push({ index, value: narrowed });
      }
    });
    if (branchResults.length !== 1) {
      errors.push({
        path,
        keyword: 'oneOf',
        message:
          branchResults.length === 0
            ? 'value does not match any allowed schema'
            : 'value matches more than one allowed schema'
      });
      return undefined;
    }
    return branchResults[0].value;
  }

  if (schema.const !== undefined) {
    if (!deepEqual(schema.const, value)) {
      errors.push({ path, keyword: 'const', message: `must equal ${JSON.stringify(schema.const)}` });
      return undefined;
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => deepEqual(candidate, value))) {
      errors.push({ path, keyword: 'enum', message: 'value is not one of the allowed values' });
      return undefined;
    }
  }

  if (schema.type !== undefined) {
    if (!matchesType(schema.type, value)) {
      errors.push({ path, keyword: 'type', message: `must be of type ${schema.type}` });
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      return value.map((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
    }
    return value;
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    const knownKeys = new Set(Object.keys(properties));
    const narrowed = {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
          errors.push({ path: `${path}.${key}`, keyword: 'required', message: 'is required' });
        }
      }
    }
    for (const key of Object.keys(value)) {
      const childValue = value[key];
      if (childValue === undefined) {
        continue;
      }
      if (knownKeys.has(key)) {
        const childPath = `${path}.${key}`;
        const narrowedChild = validateNode(properties[key], childValue, childPath, errors);
        if (narrowedChild !== undefined || !errors.some((item) => item.path === childPath)) {
          narrowed[key] = narrowedChild;
        }
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push({
          path: `${path}.${key}`,
          keyword: 'additionalProperties',
          message: 'is not a recognised property'
        });
        continue;
      }
      if (isPlainObject(schema.additionalProperties)) {
        narrowed[key] = validateNode(
          schema.additionalProperties,
          childValue,
          `${path}.${key}`,
          errors
        );
        continue;
      }
      narrowed[key] = childValue;
    }
    return narrowed;
  }

  return value;
}

/**
 * Validate and narrow a value against a subset JSON schema.
 *
 * @param {object} inputSchema
 * @param {unknown} value
 * @returns {{ok: true, value: unknown} | {ok: false, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function validateArguments(inputSchema, value) {
  assertSchemaSubset(inputSchema);
  const errors = [];
  const narrowed = validateNode(inputSchema, value, '$', errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: narrowed };
}

/** Throwing variant of `validateArguments` used by the dispatcher. */
export function assertValidArguments(inputSchema, value) {
  const result = validateArguments(inputSchema, value);
  if (result.ok) {
    return result.value;
  }
  return { ok: false, errors: result.errors };
}
