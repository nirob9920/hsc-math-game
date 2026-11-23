// Books API used by the books page (students read; admin manages).
// Cloudflare port — same routes, shapes and status codes as the Netlify
// version. The hand-rolled multipart parser is replaced with the native
// request.formData() (Workers + Node both support it).
//   GET    /api/books                      (public) → array of book records
//   POST   /api/books/file-upload          (admin, multipart pdf+title+subject+description)
//   DELETE /api/books/:id                  (admin)
//   PATCH  /api/books/:id/storage-path     (admin) { storagePath } → updated book
//   POST   /api/books/:id/extract-questions (admin) → 501 (needs AI keys; not built)
//   GET    /api/books/:id/pdf              (public) → stored PDF bytes
// Uploaded PDFs live in KV under "book-pdf:<id>"; storage_path "local:blob"
// makes the UI read them back through /api/books/:id/pdf.
// Route files pass { upload, pdf, storagePath, extract, id }; the legacy
// ?upload=1 / ?pdf=1 / ?storagePath=1 / ?extract=1 / ?id= query forms the
// Netlify _redirects produced are still honoured.
import { json, requireAdmin, parseJsonBody, newId } from './lib.js';
import { createStore } from './store.js';

const KEY = 'books';
const PDF_PREFIX = 'book-pdf:';
const MAX_PDF_BYTES = 4 * 1024 * 1024;

function str(v) {
  return typeof v === 'string' ? v : '';
}

export async function handleBooks(context, route) {
  const { request, env } = context;
  const store = createStore(env.HSC_STORE);
  const method = request.method;
  const q = new URL(request.url).searchParams;
  const isUpload = !!(route && route.upload) || q.get('upload') === '1';
  const isPdf = !!(route && route.pdf) || q.get('pdf') === '1';
  const isStoragePath = !!(route && route.storagePath) || q.get('storagePath') === '1';
  const isExtract = !!(route && route.extract) || q.get('extract') === '1';
  const id = q.get('id') || (route && route.id) || context.params.id || '';

  try {
    if (method === 'GET' && isPdf) {
      const all = await store.getJSON(KEY, []);
      const book = all.find((b) => b.id === id);
      if (!book || !String(book.storage_path || '').startsWith('local')) {
        return json(404, { error: 'Not found' });
      }
      const pdf = await store.getBinary(PDF_PREFIX + id);
      if (!pdf) return json(404, { error: 'Not found' });
      return new Response(pdf.buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (method === 'GET') {
      const all = await store.getJSON(KEY, []);
      return json(200, all);
    }

    // Everything below is admin-only.
    const gate = requireAdmin(env, request);
    if (gate.error) return gate.error;

    if (method === 'POST' && isExtract) {
      return json(501, { error: 'AI question extraction is not available on this server yet' });
    }

    if (method === 'POST' && isUpload) {
      let form;
      try {
        form = await request.formData();
      } catch {
        return json(400, { error: 'PDF file is required' });
      }
      const file = form.get('pdf');
      if (!file || typeof file === 'string' || !file.name) {
        return json(400, { error: 'PDF file is required' });
      }
      const title = str(form.get('title')).trim();
      if (!title) return json(400, { error: 'Title is required' });
      if (file.size > MAX_PDF_BYTES) {
        return json(413, { error: 'PDF is too large (max 4 MB)' });
      }
      const data = await file.arrayBuffer();
      const book = {
        id: newId(),
        title,
        subject: str(form.get('subject')) || 'গণিত',
        description: str(form.get('description')),
        file_name: file.name || 'book.pdf',
        file_size: data.byteLength,
        storage_path: 'local:blob',
        chunk_count: 0,
        created_at: new Date().toISOString(),
      };
      await store.setBinary(PDF_PREFIX + book.id, data, 'application/pdf');
      const all = await store.getJSON(KEY, []);
      all.push(book);
      await store.setJSON(KEY, all);
      return json(201, book);
    }

    if (method === 'PATCH' && isStoragePath && id) {
      const body = await parseJsonBody(request);
      const storagePath = body ? str(body.storagePath).trim() : '';
      if (!/^https?:\/\//.test(storagePath) && !storagePath.startsWith('local')) {
        return json(400, { error: 'Invalid storage path' });
      }
      const all = await store.getJSON(KEY, []);
      const book = all.find((b) => b.id === id);
      if (!book) return json(404, { error: 'Not found' });
      book.storage_path = storagePath;
      await store.setJSON(KEY, all);
      return json(200, book);
    }

    if (method === 'DELETE' && id) {
      const all = await store.getJSON(KEY, []);
      const next = all.filter((b) => b.id !== id);
      if (next.length === all.length) return json(404, { error: 'Not found' });
      await store.setJSON(KEY, next);
      await store.deleteKey(PDF_PREFIX + id);
      return json(200, { ok: true });
    }

    return json(404, { error: 'Not found' });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
}
