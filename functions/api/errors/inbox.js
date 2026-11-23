// GET|DELETE /api/errors/inbox — see _lib/errors-handler.js
import { handleErrors } from '../../_lib/errors-handler.js';

export function onRequest(context) {
  return handleErrors(context, { inbox: true });
}
