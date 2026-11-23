// /api/settings/cq — see _lib/cq-handler.js
import { handleCq } from '../../_lib/cq-handler.js';

export function onRequest(context) {
  return handleCq(context, {});
}
