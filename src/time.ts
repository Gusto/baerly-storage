import { ResolvedMPS3Config } from "mps3";
import { uint2strDesc } from "types";

export const timestamp = (epoch: number = 0) => uint2strDesc(epoch, 42);

/**
 * Converts timestamps like LastModified to their seconds since UTC epoch
 */
export const dateToSecs = (dateTimestamp: string): number => {
  return Math.floor(new Date(dateTimestamp).getTime() / 1000);
};

export const measure = async <Result>(
  work: Promise<Result>
): Promise<[Result, number]> => {
  const start = Date.now();
  return [await work, Date.now() - start];
};

export const adjustClock = (
  response: Promise<Response>,
  config: ResolvedMPS3Config
): Promise<Response> => {
  if (config.adaptiveClock) {
    return measure(response).then(([response, latency]) => {
      if (response.status !== 200) return response;
      const date_str = response.headers.get("date");
      if (date_str) {
        let error = 0;
        const server_time = new Date(date_str).getTime();
        const local_time = Date.now() + config.clockOffset;

        if (local_time < server_time - latency) {
          error = server_time - local_time - latency;
        } else if (local_time > server_time + 1000 + latency) {
          error = server_time + 1000 - local_time + latency;
        }

        if (error > 0)
          // Only allow positive clock adjustments for now
          config.clockOffset = config.clockOffset + error;

        if (error > 0) {
          console.log(
            "latency",
            latency,
            "error",
            error,
            "local_time",
            local_time,
            "server_time",
            server_time,
            "config.clockOffset",
            config.clockOffset
          );
        }
      }
      return response;
    });
  }
  return response;
};
