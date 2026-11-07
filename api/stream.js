// api/stream.js — the answer text inside a streamed AI reply
// The LeetHint server passes the provider's Server-Sent Events through
// untouched, and the own-key mode (api/direct.js) reads a provider directly;
// both use this. kind: 'openai' (OpenAI-style chat chunks: Groq, Cerebras,
// OpenRouter), 'workersai' or 'gemini'. Reasoning is ignored.
// onText(fullTextSoFar) is called as the reply streams in.
export async function readAnswerStream(res, kind, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let changed = false, nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;   // keep-alive comments etc.
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) {
        if (!text) throw new Error('The AI service stopped unexpectedly — please retry.');
        continue;
      }
      const piece = kind === 'gemini'
        ? (ev.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('')
        : (ev.choices?.[0]?.delta?.content ?? ev.response);   // Workers AI may use either shape
      if (piece) { text += piece; changed = true; }
    }
    if (changed) onText?.(text);
  }
  return text;
}
