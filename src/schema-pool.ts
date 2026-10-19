import { Worker } from 'node:worker_threads';
interface ValidationResult { valid: boolean; invalidSchema?: boolean }
interface Job { schema: unknown; value: unknown; finish: (result: ValidationResult) => void; timer: NodeJS.Timeout; settled: boolean }
interface Slot { worker: Worker; job?: Job }
/** Bounded workers keep hostile regular expressions off the HTTP event loop. */
export class SchemaPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  constructor(private maximumWorkers = 4) {}
  validate(schema: unknown, value: unknown, deadlineMs = 2000): Promise<ValidationResult> {
    if (this.queue.length >= 128) return Promise.resolve({ valid: false, invalidSchema: true });
    return new Promise(resolve => {
      const job: Job = { schema, value, settled: false, finish: result => { if (!job.settled) { job.settled = true; clearTimeout(job.timer); resolve(result); } }, timer: setTimeout(() => {
        job.finish({ valid: false, invalidSchema: true });
        const slot = this.slots.find(slot => slot.job === job);
        if (slot) { this.slots = this.slots.filter(item => item !== slot); void slot.worker.terminate(); }
        this.queue = this.queue.filter(item => item !== job); this.dispatch();
      }, deadlineMs) };
      this.queue.push(job); this.dispatch();
    });
  }
  private dispatch() {
    while (this.queue.length) {
      let slot = this.slots.find(slot => !slot.job);
      if (!slot && this.slots.length < this.maximumWorkers) {
        const worker = new Worker(new URL('./schema-worker.js', import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
        slot = { worker }; const created = slot; this.slots.push(created);
        worker.on('message', (result: ValidationResult) => { created.job?.finish(result); created.job = undefined; worker.unref(); this.dispatch(); });
        const failed = () => { created.job?.finish({ valid: false, invalidSchema: true }); this.slots = this.slots.filter(item => item !== created); this.dispatch(); };
        worker.on('error', failed); worker.on('exit', () => { if (this.slots.includes(created)) failed(); }); worker.unref();
      }
      if (!slot) return;
      slot.job = this.queue.shift()!; slot.worker.ref(); slot.worker.postMessage({ schema: slot.job.schema, value: slot.job.value });
    }
  }
  async close() { const slots = this.slots; this.slots = []; for (const job of this.queue.splice(0)) job.finish({ valid: false, invalidSchema: true }); await Promise.all(slots.map(slot => { slot.job?.finish({ valid: false, invalidSchema: true }); return slot.worker.terminate(); })); }
}
export const schemaPool = new SchemaPool();
