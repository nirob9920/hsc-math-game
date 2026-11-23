// POST /api/errors/report — see _lib/errors-handler.js
import { handleErrors } from '../../_lib/errors-handler.js';

export function onRequest(context) {
  return handleErrors(context, { report: true });
}
