// POST /api/books/:id/extract-questions — see _lib/books-handler.js
import { handleBooks } from '../../../_lib/books-handler.js';

export function onRequest(context) {
  return handleBooks(context, { extract: true, id: context.params.id });
}
