// Registered only for the synthetic request. Never pass headers, credentials or private requests to the observer.
type Observation = {
  uiStream: boolean;
  wire: (stream: boolean, response: Response, sampling?: Record<string, unknown>) => void;
};
export const matrixRequests = new WeakMap<RequestInit, Observation>();
