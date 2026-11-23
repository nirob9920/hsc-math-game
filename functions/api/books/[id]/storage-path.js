// PATCH /api/books/:id/storage-path — see _lib/books-handler.js
import { handleBooks } from '../../../_lib/books-handler.js';

export function onRequest(context) {
  return handleBooks(context, { storagePath: true, id: context.params.id });
}
