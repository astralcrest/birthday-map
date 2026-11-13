// one sound at a time: fade the old one out, then fade the new one in
export class Player {
  constructor() {
    this.ctx = null;
    this.els = [];
    this.gains = [];
    this.cur = -1;
    this.last = 1;
    this.token = 0;
    this.onend = null;
    this.freq = null;
    this.wave = null;
    this.muted = false;
  }
  get ready() { return !!this.ctx && this.ctx.state === 'running'; }
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.an = this.ctx.createAnalyser();
      this.an.fftSize = 1024;
      this.an.smoothingTimeConstant = 0.78;
      this.master.connect(this.an); this.an.connect(this.ctx.destination);
      this.freq = new Uint8Array(this.an.frequencyBinCount);
      this.wave = new Uint8Array(this.an.fftSize);
      for (let i = 0; i < 2; i++) {
        const el = new Audio();
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        el.playsInline = true;
        el.setAttribute('playsinline', '');
        el.dataset.deck = String(i);
        const src = this.ctx.createMediaElementSource(el);
        const g = this.ctx.createGain();
        g.gain.value = 0;
        src.connect(g); g.connect(this.master);
        el.addEventListener('ended', () => { if (i === this.cur && this.onend) this.onend(); });
        el.addEventListener('error', () => { if (i === this.cur && this.onend) this.onend('error'); });
        document.body.appendChild(el);
        el.hidden = true;
        this.els.push(el); this.gains.push(g);
      }
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ready;
  }
  ramp(i, to, sec) {
    const g = this.gains[i].gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(to, t + sec);
  }
  async play(url, { fadeIn = 1.4, fadeOut = 0.9, at = 0 } = {}) {
    if (!this.ctx || !url) return false;
    const my = ++this.token;
    await this.stop(fadeOut, true);
    if (my !== this.token) return false;
    const i = 1 - this.last;
    this.last = i;
    const el = this.els[i];
    el.src = url;
    try {
      el.currentTime = at;
      this.gains[i].gain.value = 0;
      await el.play();
    } catch (e) {
      return false;
    }
    if (my !== this.token) { el.pause(); return false; }
    this.cur = i;
    this.ramp(i, this.muted ? 0 : 1, fadeIn);
    return true;
  }
  async stop(fadeOut = 0.9, keepToken = false) {
    if (!keepToken) this.token++;
    if (!this.ctx || this.cur < 0) return;
    const i = this.cur, el = this.els[i];
    this.cur = -1;
    if (el.paused) return;
    this.ramp(i, 0, fadeOut);
    await new Promise(r => setTimeout(r, fadeOut * 1000 + 40));
    el.pause();
  }
  get el() { return this.cur >= 0 ? this.els[this.cur] : null; }
  get playing() { const e = this.el; return !!e && !e.paused; }
  level() {
    if (!this.an || !this.playing) return 0;
    this.an.getByteFrequencyData(this.freq);
    let s = 0;
    for (let i = 2; i < 96; i++) s += this.freq[i];
    return s / (94 * 255);
  }
  bands(n) {
    const out = new Float32Array(n);
    if (!this.an || !this.playing) return out;
    this.an.getByteFrequencyData(this.freq);
    const L = this.freq.length * 0.6;
    for (let k = 0; k < n; k++) {
      const a = Math.floor(Math.pow(k / n, 2) * L) + 1, b = Math.max(a + 1, Math.floor(Math.pow((k + 1) / n, 2) * L) + 1);
      let s = 0; for (let i = a; i < b; i++) s += this.freq[i];
      out[k] = s / ((b - a) * 255);
    }
    return out;
  }
  waveform() {
    if (!this.an || !this.playing) return null;
    this.an.getByteTimeDomainData(this.wave);
    return this.wave;
  }
}
