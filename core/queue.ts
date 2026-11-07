import { MAX_CONCURRENT_REQUESTS } from '../shared/settings';
interface Job {
  owner: string; id?: string; priority: number;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void; reject: (reason: unknown) => void;
  controller: AbortController;
}
export class RequestQueue {
  private pending: Job[] = [];
  private running = new Set<Job>();
  private plans = new Map<string, Map<string, number>>();
  private paused = false;
  private foreground = '';
  add<T>(owner: string, run: (signal: AbortSignal) => Promise<T>, priority = 0, id?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const plan = this.plans.get(owner);
      if (id && plan && !plan.has(id)) { reject(new DOMException('尚未发送。', 'AbortError')); return; }
      this.pending.push({ owner, id, priority: id ? plan?.get(id) ?? priority : priority, run, resolve: value => resolve(value as T), reject, controller: new AbortController() });
      this.pump();
    });
  }
  plan(owner: string, jobs: { id: string; priority: number }[]) {
    const plan = new Map(jobs.map(job => [job.id, job.priority === 0 ? 0 : 1]));
    this.plans.set(owner, plan);
    this.pending = this.pending.filter(job => {
      if (job.owner !== owner || !job.id) return true;
      if (!plan.has(job.id)) { job.reject(new DOMException('尚未发送。', 'AbortError')); return false; }
      job.priority = plan.get(job.id)!; return true;
    });
    for (const job of this.running) if (job.owner === owner && job.id && plan.has(job.id)) job.priority = plan.get(job.id)!;
    this.pump();
  }
  wanted(owner: string, id: string) { return this.plans.get(owner)?.has(id) ?? true; }
  focus(owner: string) { this.foreground = owner; this.pump(); }
  pause() { this.paused = true; }
  resume() { this.paused = false; this.pump(); }
  cancel(owner: string, running = true) {
    this.plans.delete(owner);
    const cancelled = this.pending.filter(job => job.owner === owner);
    this.pending = this.pending.filter(job => job.owner !== owner);
    for (const job of cancelled) job.reject(new DOMException('尚未发送。', 'AbortError'));
    if (running) for (const job of this.running) if (job.owner === owner) job.controller.abort();
  }
  private pump() {
    while (!this.paused && this.running.size < MAX_CONCURRENT_REQUESTS && this.pending.length) {
      const score = (job: Job) => (job.owner === this.foreground ? 0 : 2) + job.priority;
      this.pending.sort((a,b) => score(a)-score(b));
      // At most two speculative requests; visible work can use all ten slots.
      const speculative = [...this.running].filter(job => job.priority > 0).length;
      const index = this.pending.findIndex(job => job.priority === 0 || speculative < 2);
      if (index < 0) break;
      const [job] = this.pending.splice(index, 1);
      this.running.add(job!);
      Promise.resolve().then(() => job!.run(job!.controller.signal)).then(job!.resolve, job!.reject).finally(() => {
        this.running.delete(job!); this.pump();
      });
    }
  }
}
