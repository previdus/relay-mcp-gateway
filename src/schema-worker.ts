import { parentPort } from 'node:worker_threads';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
parentPort!.on('message', ({ schema, value }) => {
  try { parentPort!.postMessage({ valid: new AjvJsonSchemaValidator().getValidator(schema)(value).valid }); }
  catch { parentPort!.postMessage({ valid: false, invalidSchema: true }); }
});
