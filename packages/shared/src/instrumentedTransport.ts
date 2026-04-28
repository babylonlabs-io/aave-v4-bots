import { http, type HttpTransportConfig, type Transport } from "viem";

export type RpcCallObserver = (method: string) => void;

/**
 * Wraps viem's HTTP transport so every outbound JSON-RPC method is reported to
 * `observer` before being dispatched. Most RPC providers (Ankr, Alchemy, Infura)
 * bill per JSON-RPC method, not per HTTP request — so counting at this layer
 * matches what the provider charges, even when viem batches calls.
 *
 * The observer is best-effort: thrown errors inside it never affect the request.
 */
export function instrumentedHttp(
  url: string | undefined,
  observer: RpcCallObserver,
  opts?: HttpTransportConfig
): Transport {
  const inner = http(url, opts);
  return ((config) => {
    const transport = inner(config);
    const originalRequest = transport.request;
    return {
      ...transport,
      request: async (args: { method: string; params?: unknown }) => {
        try {
          observer(args.method);
        } catch {
          // Never let a metrics failure break a real RPC call.
        }
        return originalRequest(args);
      },
    };
  }) as Transport;
}
