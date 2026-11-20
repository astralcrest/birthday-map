// one sound at a time: the new one fades in as the old one fades out
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
    this.levelOf = null;
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
      // a limiter after the master: deezer clips run hot and most peak over full scale
      this.lim = this.ctx.createDynamicsCompressor();
      this.lim.threshold.value = -6; this.lim.knee.value = 0; this.lim.ratio.value = 20;
      this.lim.attack.value = .003; this.lim.release.value = .25;
      this.master.connect(this.lim); this.lim.connect(this.an); this.an.connect(this.ctx.destination);
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
  // the next clip starts on the other deck while this one fades: no silent gap between stops
  async play(url, { fadeIn = 1.4, fadeOut = 0.9, at = 0 } = {}) {
    if (!this.ctx || !url) return false;
    const my = ++this.token;
    const old = this.cur;
    const i = old >= 0 ? 1 - old : 1 - this.last;
    this.last = i;
    const el = this.els[i];
    el.dataset.tok = String(my);
    const g = this.gains[i].gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setValueAtTime(0, this.ctx.currentTime);
    el.src = url;
    try {
      el.currentTime = at;
      await el.play();
    } catch (e) {
      return false;
    }
    if (my !== this.token) { if (el.dataset.tok === String(my)) el.pause(); return false; }
    for (let j = 0; j < this.els.length; j++) if (j !== i) this.fadeAway(j, fadeOut);
    this.cur = i;
    // level each clip toward -10 LUFS from deezer's gain figure; unknown clips sit a little low behind the limiter
    const gn = this.levelOf ? this.levelOf(url) : null;
    const trim = gn == null ? .8 : Math.min(1.5, Math.max(.3, 10 ** ((-10 - gn) / 20)));
    this.ramp(i, this.muted ? 0 : trim, fadeIn);
    return true;
  }
  fadeAway(j, sec) {
    const e = this.els[j], t = e.dataset.tok;
    if (e.paused) return;
    this.ramp(j, 0, sec);
    setTimeout(() => { if (this.cur !== j && e.dataset.tok === t) e.pause(); }, sec * 1000 + 40);
  }
  async stop(fadeOut = 0.9, keepToken = false) {
    if (!keepToken) this.token++;
    if (!this.ctx || this.cur < 0) return;
    const i = this.cur, el = this.els[i], t = el.dataset.tok;
    this.cur = -1;
    if (el.paused) return;
    this.ramp(i, 0, fadeOut);
    await new Promise(r => setTimeout(r, fadeOut * 1000 + 40));
    if (el.dataset.tok === t && this.cur !== i) el.pause();
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
