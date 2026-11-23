// PATCH /api/errors/:id/resolve — see _lib/errors-handler.js
import { handleErrors } from '../../../_lib/errors-handler.js';

export function onRequest(context) {
  return handleErrors(context, { resolve: true, id: context.params.id });
}
