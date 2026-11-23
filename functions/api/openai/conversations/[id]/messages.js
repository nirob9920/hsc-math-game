// /api/openai/conversations/:id/messages — see _lib/ai-conversations-handler.js
import { handleConversations } from '../../../../_lib/ai-conversations-handler.js';

export function onRequest(context) {
  return handleConversations(context, {
    provider: 'openai',
    id: context.params.id,
    messages: true,
  });
}
