// POST /api/settings/cq/bulk-images — see _lib/cq-handler.js
import { handleCq } from '../../../_lib/cq-handler.js';

export function onRequest(context) {
  return handleCq(context, { bulkImages: true });
}
