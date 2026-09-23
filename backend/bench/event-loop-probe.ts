export interface EventLoopProbeSample {
  operationMs: number;
  immediateDelayMs: number;
  immediateRanBeforeReturn: boolean;
}

export interface EventLoopProbeHandle {
  run<T>(operation: () => T): T;
  settled(): Promise<EventLoopProbeSample>;
}

/**
 * Schedule an immediate immediately before a synchronous operation. The
 * callback cannot run while that operation owns the JavaScript thread, so its
 * delay is direct event-loop blocking evidence rather than service wall time.
 */
export function createEventLoopProbe(): EventLoopProbeHandle {
  let resolveSample: ((sample: EventLoopProbeSample) => void) | undefined;
  let rejectSample: ((error: Error) => void) | undefined;
  let started = false;
  let returned = false;
  const completion = new Promise<EventLoopProbeSample>((resolve, reject) => {
    resolveSample = resolve;
    rejectSample = reject;
  });

  return {
    run<T>(operation: () => T): T {
      if (started)
        throw new Error("Event-loop probe can measure only one operation.");
      started = true;
      const start = process.hrtime.bigint();
      let end = start;
      let immediateRanBeforeReturn = false;

      setImmediate(() => {
        immediateRanBeforeReturn = !returned;
        const callbackAt = process.hrtime.bigint();
        resolveSample?.({
          operationMs: Number(end - start) / 1e6,
          immediateDelayMs: Number(callbackAt - start) / 1e6,
          immediateRanBeforeReturn,
        });
      });

      try {
        return operation();
      } catch (error) {
        rejectSample?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      } finally {
        end = process.hrtime.bigint();
        returned = true;
      }
    },
    settled(): Promise<EventLoopProbeSample> {
      if (!started) {
        return Promise.reject(new Error("Event-loop probe was not started."));
      }
      return completion;
    },
  };
}
