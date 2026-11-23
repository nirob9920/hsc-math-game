// /api/settings/mcq/:id — see _lib/mcq-handler.js
import { handleMcq } from '../../../_lib/mcq-handler.js';

export function onRequest(context) {
  return handleMcq(context, { id: context.params.id });
}
