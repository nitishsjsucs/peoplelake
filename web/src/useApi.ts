import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api.ts";

export type Loadable<T> =
  | { state: "loading" }
  | { state: "error"; status: number | null; message: string }
  | { state: "ready"; data: T };

/** Loads once on mount (and on `reload`); errors keep their HTTP status for the page to explain. */
export function useApi<T>(load: () => Promise<T>, deps: readonly unknown[] = []): [Loadable<T>, () => void] {
  const [value, setValue] = useState<Loadable<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    setValue({ state: "loading" });
    load().then(
      (data) => live && setValue({ state: "ready", data }),
      (err: unknown) =>
        live &&
        setValue({
          state: "error",
          status: err instanceof ApiError ? err.status : null,
          message: err instanceof Error ? err.message : String(err),
        }),
    );
    return () => {
      live = false;
    };
  }, [tick, ...deps]);
  return [value, reload];
}
