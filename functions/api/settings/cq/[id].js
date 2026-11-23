// /api/settings/cq/:id — see _lib/cq-handler.js
import { handleCq } from '../../../_lib/cq-handler.js';

export function onRequest(context) {
  return handleCq(context, { id: context.params.id });
}
