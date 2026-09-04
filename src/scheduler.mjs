export class InferenceScheduler {
  #active = false;
  #finals = [];
  #previews = new Map();
  #closed = false;
  #closeWaiters = [];

  enqueueFinal(key, run) {
    if (this.#closed) return Promise.reject(new Error('scheduler closed'));
    this.cancelPreviews(key);
    return new Promise((resolve, reject) => {
      this.#finals.push({ key, run, resolve, reject, enqueuedAt: performance.now() });
      this.#pump();
    });
  }

  enqueuePreview(key, run) {
    if (this.#closed) return Promise.resolve({ superseded: true });
    const previous = this.#previews.get(key);
    if (previous) previous.resolve({ superseded: true });
    return new Promise((resolve, reject) => {
      this.#previews.set(key, { key, run, resolve, reject, enqueuedAt: performance.now() });
      this.#pump();
    });
  }

  cancelPreviews(key) {
    const pending = this.#previews.get(key);
    if (pending) {
      this.#previews.delete(key);
      pending.resolve({ superseded: true });
    }
  }

  async #pump() {
    if (this.#active || this.#closed) return;
    let job = this.#finals.shift();
    if (!job) {
      const first = this.#previews.entries().next();
      if (!first.done) {
        const [key, value] = first.value;
        this.#previews.delete(key);
        job = value;
      }
    }
    if (!job) return;
    this.#active = true;
    try {
      const result = await job.run({ queueMs: performance.now() - job.enqueuedAt });
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    } finally {
      this.#active = false;
      if (this.#closed) {
        for (const resolve of this.#closeWaiters.splice(0)) resolve();
      }
      queueMicrotask(() => this.#pump());
    }
  }

  close() {
    if (this.#closed && !this.#active) return Promise.resolve();
    this.#closed = true;
    for (const job of this.#finals.splice(0)) job.reject(new Error('scheduler closed'));
    for (const job of this.#previews.values()) job.resolve({ superseded: true });
    this.#previews.clear();
    if (!this.#active) return Promise.resolve();
    return new Promise((resolve) => this.#closeWaiters.push(resolve));
  }

  get pending() {
    return this.#finals.length + this.#previews.size + Number(this.#active);
  }
}
