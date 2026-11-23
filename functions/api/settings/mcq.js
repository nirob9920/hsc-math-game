// /api/settings/mcq — see _lib/mcq-handler.js
import { handleMcq } from '../../_lib/mcq-handler.js';

export function onRequest(context) {
  return handleMcq(context, {});
}
