// sidepanel/voice.js — Mock Interview voice: the interviewer speaks with
// speechSynthesis; the candidate answers with webkitSpeechRecognition.
// Both are built into Chrome (free, no API key). Note: Chrome's speech
// recognition sends the audio to Google's servers to transcribe it.

// ─────────────────────────────────────────────
// 1. SPEAKING
// ─────────────────────────────────────────────
let muted = false;
let speaking = false;
let preferredVoice = null;
const speakListeners = new Set();

export const isSpeaking = () => speaking;
export const isMuted = () => muted;
export function setMuted(value) {
  muted = !!value;
  if (muted) stopSpeaking();
}
// fn(true) when the interviewer starts talking, fn(false) when done
export const onSpeakingChange = fn => speakListeners.add(fn);

function setSpeaking(value) {
  speaking = value;
  speakListeners.forEach(fn => fn(value));
}

// A clear English voice — Indian English first (matches the en-IN recogniser)
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const rank = v => (v.lang === 'en-IN' ? 0 : v.lang === 'en-US' ? 2 : v.lang.startsWith('en') ? 3 : 9)
                  - (/google|natural|online/i.test(v.name) ? 1 : 0);
  return [...voices].sort((a, b) => rank(a) - rank(b))[0];
}
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener?.('voiceschanged', () => { preferredVoice = pickVoice(); });
}

// Resolves when the interviewer has finished speaking (or immediately if muted)
export function speak(text) {
  return new Promise(resolve => {
    if (muted || !text || typeof speechSynthesis === 'undefined') return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    preferredVoice = preferredVoice || pickVoice();
    if (preferredVoice) { u.voice = preferredVoice; u.lang = preferredVoice.lang; } else u.lang = 'en-IN';
    u.rate = 1.02;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      setSpeaking(false);
      resolve();
    };
    // Chrome sometimes never fires onend — don't leave the mic locked forever
    const guard = setTimeout(finish, 4000 + text.length * 90);
    u.onend = finish;
    u.onerror = finish;
    setSpeaking(true);
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  if (speaking) setSpeaking(false);
}


// ─────────────────────────────────────────────
// 2. MICROPHONE PERMISSION
//    A side panel can't show Chrome's "allow microphone" prompt, so the first
//    time it's opened once in a normal extension tab (mic-permission.html).
//    After that the permission covers the side panel too.
// ─────────────────────────────────────────────
export const speechSupported = () => !!(globalThis.webkitSpeechRecognition || globalThis.SpeechRecognition);

export async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;   // granted | denied | prompt
  } catch {
    return 'prompt';
  }
}

export function openMicPermissionPage() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/mic-permission.html') });
}


// ─────────────────────────────────────────────
// 3. LISTENING — push-to-talk
//    start() begins a listening session; recognition runs continuously and
//    restarts itself after silences until stop(). stop() resolves with
//    everything that was said. Never listens while the interviewer speaks.
// ─────────────────────────────────────────────
export class Listener {
  constructor({ onTranscript, onStateChange, onError } = {}) {
    this.onTranscript = onTranscript || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onError = onError || (() => {});
    this.active = false;     // the user wants to be listening
    this.finalText = '';     // finished phrases from earlier recognition runs
    this.runFinal = '';      // finished phrases in the current run
    this.interim = '';
    this.rec = null;
    this.stopResolve = null;
  }

  get text() {
    return [this.finalText, this.runFinal, this.interim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  start() {
    if (this.active || speaking) return false;
    const Rec = globalThis.webkitSpeechRecognition || globalThis.SpeechRecognition;
    if (!Rec) { this.onError('unsupported'); return false; }
    this.active = true;
    this.finalText = this.runFinal = this.interim = '';
    this.onTranscript('');
    this.onStateChange(true);
    this.spawn(Rec);
    return true;
  }

  spawn(Rec = globalThis.webkitSpeechRecognition || globalThis.SpeechRecognition) {
    const rec = new Rec();
    rec.lang = 'en-IN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = e => {
      let fin = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += t + ' '; else interim += t;
      }
      this.runFinal = fin.trim();
      this.interim = interim.trim();
      this.onTranscript(this.text);
    };
    rec.onerror = e => {
      // 'no-speech' / 'aborted' just end this run; onend restarts it
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.onError('not-allowed');
      } else if (e.error === 'network') {
        this.onError('network');
      }
    };
    rec.onend = () => {
      // Keep what this run heard, then restart if still in a listening session
      if (this.runFinal || this.interim) {
        this.finalText = [this.finalText, this.runFinal, this.interim].filter(Boolean).join(' ');
      }
      this.runFinal = this.interim = '';
      this.rec = null;
      if (this.active && !speaking) {
        try { this.spawn(); return; } catch { this.active = false; }
      }
      this.finishStop();
    };
    this.rec = rec;
    try { rec.start(); } catch { /* already started — harmless */ }
  }

  // Ends the session; resolves with the full transcript
  stop() {
    return new Promise(resolve => {
      this.stopResolve = resolve;
      this.active = false;
      if (this.rec) {
        try { this.rec.stop(); } catch { this.finishStop(); }
        // Final results arrive in onend; don't wait forever for them
        setTimeout(() => this.finishStop(), 1500);
      } else {
        this.finishStop();
      }
    });
  }

  // Drops everything (e.g. the interviewer started speaking)
  abort() {
    this.active = false;
    this.finalText = this.runFinal = this.interim = '';
    try { this.rec?.abort(); } catch { /* ignore */ }
    this.rec = null;
    this.onStateChange(false);
  }

  finishStop() {
    const resolve = this.stopResolve;
    if (!resolve && this.active) return;
    this.stopResolve = null;
    this.onStateChange(false);
    resolve?.(this.text);
  }
}
