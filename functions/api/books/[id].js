// /api/books/:id — see _lib/books-handler.js
import { handleBooks } from '../../_lib/books-handler.js';

export function onRequest(context) {
  return handleBooks(context, { id: context.params.id });
}
