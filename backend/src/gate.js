// backend/src/gate.js — ProblemGate, a Durable Object (one per cache key)
//
// When 50 users open a brand-new problem at the same moment, they would all
// miss the cache and make 50 AI calls for one answer. Instead every cache miss
// for a key goes through that key's gate: the first request opens the AI
// stream, the gate keeps the raw bytes as they arrive, and every later request
// gets the bytes so far and then the rest, live. One AI call, everyone served.
//
// Bytes are passed through untouched (never parsed), like the Worker does.
// When the reply ends it is stored in the shared cache; the finished job is
// kept for a minute so requests racing the cache write still get it.

import { openStream } from './providers.js';
import { putCached, isCompleteReply } from './store.js';

const KEEP_FINISHED_MS = 60_000;

export class ProblemGate {
  constructor(state, env) {
    this.env = env;
    this.job = null;   // Promise<job> while a reply is being made or was just made
  }

  // POST { prompt, opts, cacheKeys } → the reply's SSE stream
  // (headers X-LeetHint-Format / X-LeetHint-Model / X-LeetHint-Shared), or a JSON error
  async fetch(request) {
    const { prompt, opts, cacheKeys } = await request.json();
    const joining = Boolean(this.job);
    if (!this.job) this.job = this.start(prompt, opts, cacheKeys);
    let job;
    try {
      job = await this.job;
    } catch (e) {
      this.job = null;   // a failed start isn't kept: the next request tries again
      return Response.json({ status: e.status || 502, message: e.message, retryAfterMs: e.retryAfterMs },
                           { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
    }
    return new Response(this.follow(job), {
      headers: { 'X-LeetHint-Format': job.kind, 'X-LeetHint-Model': job.label, 'X-LeetHint-Shared': joining ? '1' : '0' }
    });
  }

  // Open the AI stream and read it in the background, keeping every chunk
  async start(prompt, opts, cacheKeys) {
    const { upstream, kind, label } = await openStream(this.env, prompt, opts);
    const job = { kind, label, chunks: [], done: false, failed: false, followers: new Set() };
    this.pump(job, upstream.body, cacheKeys);
    return job;
  }

  async pump(job, body, cacheKeys) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        job.chunks.push(value);
        for (const f of job.followers) f.enqueue(value);
      }
    } catch (e) {
      job.failed = true;
      console.warn('gate: stream failed —', e.message);
    }
    job.done = true;
    for (const f of job.followers) {
      try { job.failed ? f.error(new Error('The AI stream stopped')) : f.close(); } catch { /* already closed */ }
    }
    job.followers.clear();
    if (!job.failed) await this.store(job, cacheKeys);
    const timer = setTimeout(() => { if (this.job) this.job = null; }, KEEP_FINISHED_MS);
    timer?.unref?.();   // (Node, in tests) don't keep the process alive for it
  }

  async store(job, cacheKeys) {
    try {
      const raw = await new Blob(job.chunks).text();
      if (!isCompleteReply(raw, job.kind)) return;
      for (const key of cacheKeys) await putCached(this.env, key, raw, job.kind);
    } catch (e) {
      console.warn('gate: cache write skipped —', e.message);
    }
  }

  // Everything so far, then the rest as it arrives
  follow(job) {
    let me;
    return new ReadableStream({
      start(controller) {
        for (const chunk of job.chunks) controller.enqueue(chunk);
        if (job.done) {
          job.failed ? controller.error(new Error('The AI stream stopped')) : controller.close();
        } else {
          me = controller;
          job.followers.add(controller);
        }
      },
      cancel() { if (me) job.followers.delete(me); }   // this user closed the panel — the others go on
    });
  }
}
