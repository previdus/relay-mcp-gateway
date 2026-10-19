/** Stops waiting for cooperative work; it cannot stop a trusted plugin's CPU loop or undo effects. */
export function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}
