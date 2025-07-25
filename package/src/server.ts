import type { Handle, RequestEvent } from '@sveltejs/kit';
import type {
  AnyRouter,
  ProcedureType,
  TRPCError,
  inferRouterContext,
  inferRouterError
} from '@trpc/server';
import { resolveResponse, type ResponseMeta } from '@trpc/server/http';
import type { TRPCResponse } from '@trpc/server/rpc';
import { serialize, type CookieSerializeOptions } from 'cookie';
import type { ValidRoute } from './ValidRoute';

/**
 * Create a SvelteKit handle function for tRPC requests.
 *
 * If you want to use it in conjunction with other SvelteKit handles,
 * consider [the sequence helper function](https://kit.svelte.dev/docs/modules#sveltejs-kit-hooks).
 * @see https://kit.svelte.dev/docs/hooks
 */
export function createTRPCHandle<Router extends AnyRouter, URL extends string>({
  router,
  url = '/trpc',
  createContext,
  responseMeta,
  onError
}: {
  /**
   * The tRPC router to use.
   * @see https://trpc.io/docs/router
   */
  router: Router;

  /**
   * The tRPC api endpoint URL.
   * @default '/trpc'
   */
  url?: ValidRoute<URL>;

  /**
   * A function that returns the tRPC context.
   * @see https://trpc.io/docs/context
   */
  createContext?: (
    event: RequestEvent
  ) => inferRouterContext<Router> | Promise<inferRouterContext<Router>>;

  /**
   * A function that returns the response meta.
   * @see https://trpc.io/docs/caching#using-responsemeta-to-cache-responses
   */
  responseMeta?: (opts: {
    data: TRPCResponse<unknown, inferRouterError<Router>>[];
    ctx?: inferRouterContext<Router>;
    paths: readonly string[];
    type: ProcedureType | 'unknown';
    errors: TRPCError[];
  }) => ResponseMeta;

  /**
   * A function that is called when an error occurs.
   * @see https://trpc.io/docs/error-handling#handling-errors
   */
  onError?: (opts: {
    ctx?: inferRouterContext<Router>;
    error: TRPCError;
    path: string;
    input: unknown;
    req: RequestInit;
    type: ProcedureType | 'unknown';
  }) => void;
}): Handle {
  return async ({ event, resolve }) => {
    if (event.url.pathname.startsWith(url + '/')) {
      const request = event.request;

      // Using the default `event.setHeaders` and `event.cookies` will not work
      // as the event in not resolved by SvelteKit. Instead, we "proxy" the access
      // to the headers.
      const originalSetHeaders = event.setHeaders;
      const originalSetCookies = event.cookies.set;
      const originalDeleteCookies = event.cookies.delete;
      const headersProxy: Record<string, string> = {};
      const cookiesProxy: Record<string, { value: string; options: CookieSerializeOptions }> = {};

      // Same as the one provided from sveltekit
      const defaultCookiesOptions: CookieSerializeOptions = {
        httpOnly: true,
        sameSite: 'lax',
        secure: event.url.hostname === 'localhost' && event.url.protocol === 'http:' ? false : true
      };

      event.setHeaders = (headers) => {
        for (const [key, value] of Object.entries(headers)) {
          headersProxy[key] = value;
        }
        // Still call the original `event.setHeaders` function, as it may be used in SvelteKit internals.
        originalSetHeaders(headers);
      };
      event.cookies.set = (name, value, options) => {
        cookiesProxy[name] = { value, options: { ...defaultCookiesOptions, ...options } };
        originalSetCookies(name, value, options);
      };
      event.cookies.delete = (name, options) => {
        cookiesProxy[name] = { value: '', options: { ...options, maxAge: 0 } };
        originalDeleteCookies(name, options);
      };

      const httpResponse = await resolveResponse({
        router,
        req: request,
        path: event.url.pathname.substring(url.length + 1),
        createContext: async () => createContext?.(event),
        responseMeta,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: onError as any
      });

      const status = httpResponse.status;
      const body = await httpResponse.text();

      const finalHeaders = new Headers();

      // Copy headers from response
      httpResponse.headers.forEach((value, key) => {
        finalHeaders.set(key, value);
      });

      for (const [key, value] of Object.entries(headersProxy)) {
        finalHeaders.set(key, value);
      }

      if (Object.keys(cookiesProxy).length > 0) {
        for (const [name, { value, options }] of Object.entries(cookiesProxy)) {
          const serializedCookie = serialize(name, value, options);
          finalHeaders.append('Set-Cookie', serializedCookie);
        }
      }

      return new Response(body, { status, headers: finalHeaders });
    }

    return resolve(event);
  };
}
