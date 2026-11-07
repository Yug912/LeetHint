// backend/src/gate.js — ProblemGate: identical cache misses share ONE AI call.
//
// When a new problem is opened by many users at once (a contest just ended, a
// link shared in a group), every request misses the cache together and each
// would start its own AI call. Instead, every miss for a cache key goes to the
// ProblemGate named after that key (one Durable Object per key):
//   • the first request opens the AI stream inside the gate;
//   • the gate keeps the raw bytes as they arrive and replays them to every
//     later request for the same key, then hands it the live tail;
//   • when the reply completes, the gate writes the cache and closes.
// Bytes pass through untouched — chunks are only stored and forwarded, never
// parsed (the free plan's 10 ms CPU limit).

import { openStream } from './providers.js';
import { isCompleteReply, writeCache } from './store.js';

export class ProblemGate {
  constructor(ctx, env) {
    this.env = env;
    this.flight = null;   // the reply being generated: { opening, chunks, done, listeners, kind, label }
  }

  async fetch(request) {
    const { prompt, opts, cacheKeys } = await request.json();
    const joined = !!this.flight;
    if (!this.flight) this.flight = this.start(prompt, opts, cacheKeys);
    const flight = this.flight;
    try {
      await flight.opening;
    } catch (e) {
      // Tell the Worker exactly what went wrong, so it answers as it would have
      return Response.json({ status: e.status || 502, message: e.message, busy: !!e.busy,
                             retryAfterMs: e.retryAfterMs, dailyShare: e.dailyShare || '' }, { status: 599 });
    }
    // Everything received so far, then the live tail
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of flight.chunks) controller.enqueue(chunk);
        if (flight.done) controller.close();
        else flight.listeners.add(controller);
      },
      cancel() { /* a user closed the panel — the others keep receiving */ }
    });
    return new Response(stream, {
      headers: { 'X-LeetHint-Format': flight.kind, 'X-LeetHint-Model': flight.label, 'X-LeetHint-Gate': joined ? 'joined' : 'first' }
    });
  }

  start(prompt, opts, cacheKeys) {
    const flight = { chunks: [], done: false, listeners: new Set(), kind: '', label: '' };
    const pump = async upstream => {
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          flight.chunks.push(value);
          for (const c of flight.listeners) {
            try { c.enqueue(value); } catch { flight.listeners.delete(c); }   // that client left
          }
        }
      } catch (e) {
        console.warn('gate: upstream stream failed:', e.message);
      } finally {
        flight.done = true;
        for (const c of flight.listeners) { try { c.close(); } catch {} }
        flight.listeners.clear();
        await this.finish(flight, cacheKeys);
      }
    };
    flight.opening = openStream(this.env, prompt, opts).then(({ upstream, kind, label }) => {
      flight.kind = kind;
      flight.label = label;
      console.log(`gate ${cacheKeys[0]?.split(':').slice(1, 3).join(' ')} → ${label}`);
      pump(upstream);   // runs on after this request is answered
    });
    flight.opening.catch(() => { if (this.flight === flight) this.flight = null; });   // next request tries again
    return flight;
  }

  async finish(flight, cacheKeys) {
    try {
      const raw = new TextDecoder().decode(concat(flight.chunks));
      if (isCompleteReply(raw, flight.kind)) {
        for (const key of cacheKeys) await writeCache(this.env, key, raw, flight.kind);
      }
    } catch (e) {
      console.warn('gate: cache write skipped:', e.message);
    }
    if (this.flight === flight) this.flight = null;   // later requests read the cache
  }
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// Worker side: send a cache miss through its gate. → { upstream, kind, label }
// like openStream(), or throws the same errors openStream() would.
export async function openThroughGate(env, cacheKey, prompt, opts, cacheKeys) {
  const stub = env.GATE.get(env.GATE.idFromName(cacheKey));
  const res = await stub.fetch('https://gate/open', { method: 'POST', body: JSON.stringify({ prompt, opts, cacheKeys }) });
  if (res.status === 599) {
    const info = await res.json();
    const e = new Error(info.message);
    Object.assign(e, { status: info.status, busy: info.busy, retryAfterMs: info.retryAfterMs, dailyShare: info.dailyShare || undefined });
    throw e;
  }
  return { upstream: res, kind: res.headers.get('X-LeetHint-Format') || 'openai',
           label: `${res.headers.get('X-LeetHint-Model') || '?'}${res.headers.get('X-LeetHint-Gate') === 'joined' ? ' [joined]' : ''}`, gated: true };
}
