/** MCP 2026-07-28 SEP-2243. Independent bounded scan: only static property chains qualify. */
export class InvalidParameterHeaders extends Error { constructor() { super('Tool has invalid parameter-header annotations or values'); } }
const nested = new Set(['items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions']);
const maps = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions']);
export function parameterDeclarations(schema: unknown) {
  const declarations: { path: string[]; name: string; type: string }[] = [], names = new Set<string>();
  const pending = [{ schema, path: [] as string[], reachable: true, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 2048 || item.depth > 32) throw new InvalidParameterHeaders();
    if (!item.schema || typeof item.schema !== 'object' || Array.isArray(item.schema)) continue;
    const value = item.schema as Record<string, unknown>;
    if (Object.hasOwn(value, 'x-mcp-header')) {
      const name = value['x-mcp-header'];
      if (!item.reachable || !item.path.length || typeof name !== 'string' || !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(name) || typeof value.type !== 'string' || !['string', 'integer', 'boolean'].includes(value.type) || names.has(name.toLowerCase())) throw new InvalidParameterHeaders();
      names.add(name.toLowerCase()); declarations.push({ path: item.path, name, type: String(value.type) });
    }
    const properties = value.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) for (const [key, child] of Object.entries(properties)) pending.push({ schema: child, path: [...item.path, key], reachable: item.reachable, depth: item.depth + 1 });
    for (const key of nested) {
      const child = value[key];
      const branches = Array.isArray(child) ? child : child && typeof child === 'object' && maps.has(key) ? Object.values(child) : [child];
      for (const schema of branches) if (schema && typeof schema === 'object') pending.push({ schema, path: item.path, reachable: false, depth: item.depth + 1 });
    }
  }
  return declarations;
}
export function parameterHeaders(schema: unknown, args: Record<string, unknown>) {
  const headers: Record<string, string> = {}; let bytes = 0;
  for (const declaration of parameterDeclarations(schema)) {
    let value: unknown = args;
    for (const key of declaration.path) value = value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    if (value === undefined || value === null) continue;
    if (declaration.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== declaration.type) throw new InvalidParameterHeaders();
    const text = String(value);
    const encoded = !text || text !== text.trim() || /[^\x09\x20-\x7e]/u.test(text) || text.startsWith('=?base64?') && text.endsWith('?=') ? `=?base64?${Buffer.from(text).toString('base64')}?=` : text;
    const name = `Mcp-Param-${declaration.name}`;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(encoded);
    if (bytes > 8192) throw new InvalidParameterHeaders();
    headers[name] = encoded;
  }
  return headers;
}

export class ParameterHeaderMismatch extends Error { constructor() { super('Tool parameter header does not match its body value'); } }
function decode(value: string) {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice(9, -2), bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new ParameterHeaderMismatch();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ParameterHeaderMismatch(); }
}
export function validateParameterHeaders(schema: unknown, args: Record<string, unknown>, received: Record<string, string | string[] | undefined>) {
  const expected = parameterHeaders(schema, args);
  for (const declaration of parameterDeclarations(schema)) {
    const name = `Mcp-Param-${declaration.name}`, raw = received[name.toLowerCase()], value = expected[name];
    if (value === undefined) { if (raw !== undefined) throw new ParameterHeaderMismatch(); continue; }
    if (typeof raw !== 'string') throw new ParameterHeaderMismatch();
    const actual = decode(raw), want = decode(value);
    if (declaration.type === 'integer') {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(actual) || !Number.isSafeInteger(Number(actual)) || Number(actual) !== Number(want)) throw new ParameterHeaderMismatch();
    } else if (actual !== want) throw new ParameterHeaderMismatch();
  }
}
