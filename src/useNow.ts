import { useEffect, useState } from "react";

const currentUnixTime = () => Math.floor(Date.now() / 1000);

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(currentUnixTime);
  useEffect(() => {
    const timer = setInterval(() => setNow(currentUnixTime()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
